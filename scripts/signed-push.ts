#!/usr/bin/env bun
/**
 * scripts/signed-push.ts
 *
 * `git push` replacement for GitHub App agents. Commits pushed with plain git
 * are unsigned; commits created through the REST Git Data API with no
 * author/committer are signed by GitHub. This helper replays the local commits
 * not yet on the remote (topological order) through that API using the
 * per-owner installation token: per commit `POST /git/trees` (base tree = the
 * first parent's tree, entries from `git diff-tree` against it) then `POST /git/commits`
 * with the mapped parents and the original message, checking
 * `verification.verified` on every response. Nothing is visible on the remote
 * until the branch ref moves, so a failure mid-replay leaves only unreferenced
 * objects. The ref moves once, at the end, and only after the final commit's
 * tree equals the local `HEAD^{tree}`: `POST /git/refs` for a new branch,
 * `PATCH /git/refs/heads/<branch>` with `force: false` for an existing one.
 * Then the worktree is synced (`git fetch` + `git reset --mixed <newhead>`,
 * never `--hard`: the trees are identical so uncommitted work survives).
 *
 * Request volume is kept low because GitHub rate-limits content-creating
 * requests (documented around 80/min and 500/hour; NOT VERIFIED here): blobs
 * already present in a parent commit on the remote are referenced by sha, text
 * goes inline in the tree request, only binary files use `POST /git/blobs`,
 * requests run under a concurrency cap, and 403/429 rate-limit responses are
 * retried with backoff honouring Retry-After before failing with a git-style
 * error.
 *
 * Reads (default branch, remote head) use REST too, so there is one client.
 *
 * Token: `SHIPWRIGHT_GH_OWNER` selects `gh-token.d/<owner>`, a directory next
 * to the file at `$GH_TOKEN_FILE` (same convention as
 * scripts/bin/git-credential-shipwright.sh; owner validation shared with
 * runtime/gh-token-files.ts).
 *
 * Merge commits keep every parent (a parent that is not part of the replay is
 * already on the remote and is used as-is), tree entries carry the real mode
 * and type (executables, symlinks, submodules as commit entries, deletes as
 * `sha: null`), and root commits / unrelated history are fine because the ref
 * is only created at the final tip.
 *
 * A push the helper cannot reproduce exactly must not silently differ, so it
 * refuses (exit 1, message ending in the `SHIPWRIGHT_SIGNED_COMMITS=off git
 * push ...` bypass): force/tag/delete pushes, --all/--mirror, multiple
 * refspecs, and commits over the payload cap.
 * Other failures read like git's own: a non-fast-forward push prints
 * `! [rejected] <branch> -> <branch> (fetch first)` and `error: failed to push
 * some refs to <url>`. A short hint is added only where the cause is the agent
 * environment (a commit GitHub did not sign, a missing owner or token).
 *
 * Size cap: default 10 MB of base64 payload per commit, override with
 * `SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES`. NOT VERIFIED: GitHub does not
 * document a limit for this flow; the cap is a conservative guard, not a known
 * GitHub constant. Tune it if a real limit is observed.
 *
 * Usage: bun scripts/signed-push.ts [git push args...]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateOwner } from "../runtime/gh-token-files.ts";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const API_URL = "https://api.github.com";

/** A push the helper deliberately will not perform; message teaches the bypass. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export interface PushArgs {
  raw: string[];
  remote?: string;
  refspecs: string[];
  setUpstream: boolean;
  force: boolean;
  tags: boolean;
  delete: boolean;
  /** --all or --mirror */
  all: boolean;
}

/** Flags that take a separate value argument. */
const VALUE_FLAGS = new Set([
  "--repo",
  "-o",
  "--push-option",
  "--receive-pack",
]);

export function parseArgs(argv: string[]): PushArgs {
  const out: PushArgs = {
    raw: [...argv],
    refspecs: [],
    setUpstream: false,
    force: false,
    tags: false,
    delete: false,
    all: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-u" || a === "--set-upstream") out.setUpstream = true;
    else if (a === "-f" || a === "--force") out.force = true;
    else if (a === "--force-with-lease" || a.startsWith("--force-with-lease="))
      out.force = true;
    else if (a === "--force-if-includes") out.force = true;
    else if (a === "--tags") out.tags = true;
    else if (a === "-d" || a === "--delete") out.delete = true;
    else if (a === "--all" || a === "--mirror") out.all = true;
    else if (VALUE_FLAGS.has(a)) i++;
    else if (a.startsWith("-") && a !== "-") continue;
    else positional.push(a);
  }
  out.remote = positional[0];
  out.refspecs = positional.slice(1);
  return out;
}

/** Message ending in the bypass hint, reproducing the user's original args. */
export function refusalMessage(reason: string, rawArgs: string[]): string {
  const cmd = ["git", "push", ...rawArgs].join(" ");
  return [
    `signed-push: refusing — ${reason}.`,
    "GitHub's commit API (used to create signed commits) cannot reproduce this exactly.",
    "If an unsigned push is acceptable here, bypass the helper with:",
    `SHIPWRIGHT_SIGNED_COMMITS=off ${cmd}`,
  ].join("\n");
}

/** Throws a Refusal for push forms that never go through the replay. */
export function assertReplayable(args: PushArgs): void {
  const why = args.force
    ? "force pushes rewrite history, which the commit API cannot do"
    : args.tags
      ? "tag pushes are not supported"
      : args.delete
        ? "branch deletes are not supported"
        : args.all
          ? "--all/--mirror pushes are not supported"
          : undefined;
  if (why) throw new Refusal(refusalMessage(why, args.raw));
}

/** Resolve the single destination branch name for this push. */
export function resolveBranch(
  args: PushArgs,
  currentBranch: string | undefined,
): string {
  const refuse = (why: string): never => {
    throw new Refusal(refusalMessage(why, args.raw));
  };
  if (args.refspecs.length > 1) refuse("multiple refspecs are not supported");
  const spec = args.refspecs[0];
  if (spec === undefined) {
    return currentBranch ?? refuse("HEAD is detached; name a branch to push");
  }
  if (spec.startsWith("+")) refuse("a '+' refspec is a force push");
  const [src, dst = src] = spec.split(":") as [string, string?];
  if (src === "") refuse("an empty source refspec deletes the remote branch");
  const strip = (r: string) => r.replace(/^refs\/heads\//, "");
  if (src !== "HEAD" && strip(src) !== currentBranch) {
    refuse(`only the checked-out branch can be pushed (got '${src}')`);
  }
  const target = dst === "HEAD" ? currentBranch : dst;
  if (!target) return refuse("HEAD is detached; name a destination branch");
  if (target.startsWith("refs/") && !target.startsWith("refs/heads/")) {
    refuse(`only branches can be pushed (got '${target}')`);
  }
  return strip(target);
}

export interface Addition {
  path: string;
  sha: string;
  mode: string;
}
export interface Deletion {
  path: string;
  mode: string;
}
export interface Classified {
  additions: Addition[];
  deletions: Deletion[];
}

/**
 * Classify `git diff-tree -r -z --no-renames --raw` output. Renames never
 * appear (they arrive as delete + add). Modes are kept as-is: regular files,
 * executables, symlinks (120000) and submodules (160000) are all expressible.
 */
export function classifyDiff(raw: string): Classified {
  const out: Classified = { additions: [], deletions: [] };
  const tokens = raw.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = (tokens[i] as string).replace(/^:/, "").split(" ");
    const path = tokens[i + 1] as string;
    const [oldMode, newMode, , newSha, status] = meta as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (newMode === "000000" || status === "D") {
      out.deletions.push({ path, mode: oldMode });
    } else {
      out.additions.push({ path, sha: newSha, mode: newMode });
    }
  }
  return out;
}

/** A submodule pointer is a `commit` entry; everything else is a blob. */
export const entryType = (mode: string) =>
  mode === "160000" ? "commit" : "blob";

/** Map parents through the old->new SHA map; unmapped ones are already on the remote. */
export const mapParents = (parents: string[], newSha: Map<string, string>) =>
  parents.map((p) => newSha.get(p) ?? p);

/** Tree entry that deletes `path` (`sha: null`) with its previous mode/type. */
export function deletionEntry(d: Deletion) {
  return { path: d.path, mode: d.mode, type: entryType(d.mode), sha: null };
}

export function readMaxBytes(env: Record<string, string | undefined>): number {
  const n = Number(env.SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

/** `owner/repo` from a github.com https or ssh remote URL. */
export function parseRepoSlug(url: string): string | undefined {
  const m = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m?.[1];
}
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** git-style rejection; message is the exact text printed to stderr. */
export class PushRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRejected";
  }
}

export type ApiClient = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

/** GitHub kept answering with a rate limit after every retry. */
export class RateLimitError extends ApiError {
  constructor(
    status: number,
    message: string,
    /** Seconds GitHub asked us to wait, when it said. */
    readonly retryAfter?: number,
  ) {
    super(status, message);
    this.name = "RateLimitError";
  }
}

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_RETRIES = 4;
/** Longest single wait honoured; a longer Retry-After fails fast instead. */
export const DEFAULT_MAX_DELAY_MS = 120_000;
const BASE_BACKOFF_MS = 2_000;

/**
 * Seconds to wait before retrying a rate-limited response, or undefined when
 * the response is not a rate limit. 429 always is; 403 only with a Retry-After
 * header, an exhausted primary quota, or a rate-limit message.
 */
export function rateLimitDelay(
  status: number,
  headers: Headers,
  message: string,
  attempt: number,
  nowMs: number,
): number | undefined {
  const limited =
    status === 429 ||
    (status === 403 &&
      (headers.has("retry-after") ||
        headers.get("x-ratelimit-remaining") === "0" ||
        /rate limit|abuse/i.test(message)));
  if (!limited) return undefined;
  const retryAfter = Number(headers.get("retry-after"));
  if (headers.has("retry-after") && Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter);
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && reset > 0) {
    return Math.max(0, reset - nowMs / 1000);
  }
  return (BASE_BACKOFF_MS * 2 ** attempt) / 1000;
}

export function createApiClient(opts: {
  fetch: typeof fetch;
  token: string;
  url?: string;
  /** Requests in flight at once. */
  concurrency?: number;
  maxRetries?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): ApiClient {
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = async () => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    else active++;
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  // A rate limit applies to every in-flight caller, not just the one that saw it.
  let pausedUntil = 0;

  const send = async (method: string, path: string, body: unknown) => {
    const res = await opts.fetch(`${opts.url ?? API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "shipwright-signed-push",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const detail =
      (json as { message?: string } | undefined)?.message ?? text.slice(0, 200);
    return { res, json, detail };
  };

  return async <T>(method: string, path: string, body?: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const wait = pausedUntil - now();
      if (wait > 0) await sleep(wait);
      await acquire();
      let out: Awaited<ReturnType<typeof send>>;
      try {
        out = await send(method, path, body);
      } finally {
        release();
      }
      const { res, json, detail } = out;
      if (res.ok) return json as T;
      const message = `GitHub API ${method} ${path} failed: HTTP ${res.status} ${detail}`;
      const delay = rateLimitDelay(
        res.status,
        res.headers,
        detail,
        attempt,
        now(),
      );
      if (delay === undefined) throw new ApiError(res.status, message);
      const delayMs = Math.ceil(delay * 1000);
      if (attempt >= maxRetries || delayMs > maxDelayMs) {
        throw new RateLimitError(res.status, message, delay);
      }
      pausedUntil = Math.max(pausedUntil, now() + delayMs);
    }
  };
}

/** Encode a branch name for a URL path, keeping `/` separators. */
const refPath = (branch: string) =>
  branch.split("/").map(encodeURIComponent).join("/");

/** UTF-8 text that survives a string round trip can go inline as tree content. */
function asInlineText(buf: Buffer): string | undefined {
  if (buf.length === 0 || buf.includes(0)) return undefined;
  const s = buf.toString("utf8");
  return Buffer.from(s, "utf8").equals(buf) ? s : undefined;
}

interface CreatedCommit {
  sha: string;
  tree: { sha: string };
  verification?: { verified: boolean; reason?: string };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function runGit(cwd: string, args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  return {
    code: p.exitCode,
    stdout: p.stdout as Buffer,
    text: p.stdout.toString().trim(),
    err: p.stderr.toString().trim(),
  };
}

/** Blob sha of `path` in commit `rev`, if it exists there. */
function blobAt(cwd: string, rev: string, path: string): string | undefined {
  const r = runGit(cwd, ["rev-parse", "--verify", "-q", `${rev}:${path}`]);
  return r.code === 0 ? r.text : undefined;
}

function gitOk(cwd: string, args: string[]): string {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
  return r.text;
}

export function readOwnerToken(env: Record<string, string | undefined>) {
  const owner = env.SHIPWRIGHT_GH_OWNER;
  if (!owner) {
    throw new Error(
      "signed-push: SHIPWRIGHT_GH_OWNER is not set; prefix the command with SHIPWRIGHT_GH_OWNER=<org>.",
    );
  }
  if (!env.GH_TOKEN_FILE)
    throw new Error("signed-push: GH_TOKEN_FILE is not set");
  const name = validateOwner(owner);
  const file = join(dirname(env.GH_TOKEN_FILE), "gh-token.d", name);
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(
      `signed-push: no GitHub App installation token for org '${name}' (${file}).`,
    );
  }
}

export interface SignedPushOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  fetch: typeof fetch;
  /** `owner/repo`; derived from the remote URL when omitted. */
  repo?: string;
  /** Test hooks for the request client (concurrency, retries, sleep). */
  client?: Partial<Parameters<typeof createApiClient>[0]>;
}

interface Plan {
  sha: string;
  parents: string[];
  message: string;
  /** `contents` is the blob (or symlink target); submodules carry `commit`. */
  additions: {
    path: string;
    mode: string;
    contents?: Buffer;
    commit?: string;
    /** Blob sha already present in a parent commit that is on the remote. */
    remoteSha?: string;
  }[];
  deletions: Deletion[];
}

export async function signedPush(
  opts: SignedPushOptions,
): Promise<{ message: string }> {
  try {
    return await replayPush(opts);
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;
    const remote = parseArgs(opts.argv).remote ?? "origin";
    const url = runGit(opts.cwd, ["remote", "get-url", remote]).text || remote;
    const wait =
      err.retryAfter === undefined
        ? ""
        : ` Retry in about ${Math.ceil(err.retryAfter)}s.`;
    throw new PushRejected(
      [
        `error: GitHub rate-limited the push (HTTP ${err.status}; secondary limits apply to content-creating requests).${wait}`,
        `error: failed to push some refs to '${url}'`,
      ].join("\n"),
    );
  }
}

async function replayPush(
  opts: SignedPushOptions,
): Promise<{ message: string }> {
  const { cwd, env } = opts;
  const args = parseArgs(opts.argv);
  assertReplayable(args);
  const refuse = (why: string): never => {
    throw new Refusal(refusalMessage(why, args.raw));
  };

  const current = runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).text;
  const branch = resolveBranch(args, current || undefined);
  const remote = args.remote ?? "origin";
  const token = readOwnerToken(env);
  const maxBytes = readMaxBytes(env);

  const remoteUrl = gitOk(cwd, ["remote", "get-url", remote]);
  const repo = opts.repo ?? parseRepoSlug(remoteUrl);
  if (!repo) {
    throw new Error(`signed-push: remote '${remote}' is not a github.com URL`);
  }
  const api = createApiClient({ fetch: opts.fetch, token, ...opts.client });
  const repoPath = `/repos/${repo}`;
  const rejected = (): never => {
    throw new PushRejected(
      [
        ` ! [rejected]        ${branch} -> ${branch} (fetch first)`,
        `error: failed to push some refs to '${remoteUrl}'`,
      ].join("\n"),
    );
  };

  const readRef = async (b: string) => {
    try {
      const r = await api<{ object: { sha: string } }>(
        "GET",
        `${repoPath}/git/ref/heads/${refPath(b)}`,
      );
      return r.object.sha;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return undefined;
      throw err;
    }
  };

  const hasObject = (oid: string) =>
    runGit(cwd, ["cat-file", "-e", `${oid}^{commit}`]).code === 0;
  const ensureObject = (oid: string) => {
    if (!hasObject(oid)) runGit(cwd, ["fetch", remote]);
    return hasObject(oid);
  };

  const remoteHead = await readRef(branch);
  const isNew = remoteHead === undefined;
  // Everything reachable from these is already on the remote and is not replayed.
  const exclude: string[] = [];
  const repoInfo = await api<{ default_branch: string }>("GET", repoPath);
  const defaultHead = await readRef(repoInfo.default_branch);
  if (remoteHead) {
    if (!ensureObject(remoteHead)) rejected();
    if (
      runGit(cwd, ["merge-base", "--is-ancestor", remoteHead, "HEAD"]).code !==
      0
    )
      rejected();
    exclude.push(remoteHead);
  } else {
    if (!defaultHead || !ensureObject(defaultHead)) {
      return refuse(
        "cannot find the default branch to create the new branch from",
      );
    }
  }
  if (defaultHead && ensureObject(defaultHead)) exclude.push(defaultHead);

  const lines = gitOk(cwd, [
    "rev-list",
    "--reverse",
    "--topo-order",
    "--parents",
    "HEAD",
    "--not",
    ...exclude,
  ])
    .split("\n")
    .filter(Boolean);
  if (lines.length === 0 && !isNew) {
    return { message: "Everything up-to-date" };
  }

  // Validate every commit before any API call so a refusal changes nothing.
  const emptyTree = gitOk(cwd, ["hash-object", "-t", "tree", "/dev/null"]);
  const replayed = new Set(lines.map((l) => l.split(" ")[0] as string));
  const plans: Plan[] = lines.map((line) => {
    const [sha, ...parents] = line.split(" ") as [string, ...string[]];
    // Parents outside the replay are on the remote, so any blob they hold
    // already exists there and can be referenced by sha instead of uploaded.
    const remoteParents = parents.filter((p) => !replayed.has(p));
    // Diff against the first parent (or the empty tree for a root commit): the
    // tree entries are relative to the first parent's tree.
    const diff = runGit(cwd, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--raw",
      parents[0] ?? emptyTree,
      sha,
    ]);
    const c = classifyDiff(diff.stdout.toString());
    let bytes = 0;
    const additions = c.additions.map((a) => {
      if (entryType(a.mode) === "commit") {
        return { path: a.path, mode: a.mode, commit: a.sha };
      }
      if (remoteParents.some((p) => blobAt(cwd, p, a.path) === a.sha)) {
        return { path: a.path, mode: a.mode, remoteSha: a.sha };
      }
      const contents = runGit(cwd, ["cat-file", "blob", a.sha]).stdout;
      bytes += Math.ceil((contents.length * 4) / 3);
      if (bytes > maxBytes) {
        refuse(
          `commit ${sha.slice(0, 7)} exceeds the ${maxBytes} byte payload cap (SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES)`,
        );
      }
      return { path: a.path, mode: a.mode, contents };
    });
    const message = gitOk(cwd, ["log", "-1", "--format=%B", sha]);
    return { sha, parents, message, additions, deletions: c.deletions };
  });

  const bypass = `SHIPWRIGHT_SIGNED_COMMITS=off ${["git", "push", ...args.raw].join(" ")}`;
  const newSha = new Map<string, string>();
  const newTree = new Map<string, string>();
  let head = gitOk(cwd, ["rev-parse", "HEAD"]);
  let headTree = gitOk(cwd, ["rev-parse", "HEAD^{tree}"]);
  for (const [i, plan] of plans.entries()) {
    // A parent outside the replay is already on the remote: use it as-is.
    const parent = plan.parents[0];
    const baseTree =
      parent === undefined
        ? undefined
        : (newTree.get(parent) ??
          gitOk(cwd, ["rev-parse", `${parent}^{tree}`]));
    // Binary files need a blob request; the client caps how many run at once.
    const entries: Record<string, unknown>[] = await Promise.all(
      plan.additions.map(async (a) => {
        const base = { path: a.path, mode: a.mode };
        if (a.commit !== undefined) {
          return { ...base, type: "commit", sha: a.commit };
        }
        if (a.remoteSha !== undefined) {
          return { ...base, type: "blob", sha: a.remoteSha };
        }
        const contents = a.contents as Buffer;
        const text = asInlineText(contents);
        if (text !== undefined) return { ...base, type: "blob", content: text };
        const blob = await api<{ sha: string }>(
          "POST",
          `${repoPath}/git/blobs`,
          { content: contents.toString("base64"), encoding: "base64" },
        );
        return { ...base, type: "blob", sha: blob.sha };
      }),
    );
    for (const d of plan.deletions) entries.push(deletionEntry(d));
    const tree = await api<{ sha: string }>("POST", `${repoPath}/git/trees`, {
      base_tree: baseTree,
      tree: entries,
    });
    // No author/committer: GitHub signs commits it attributes itself.
    const commit = await api<CreatedCommit>("POST", `${repoPath}/git/commits`, {
      message: plan.message,
      tree: tree.sha,
      parents: mapParents(plan.parents, newSha),
    });
    if (!commit.verification?.verified) {
      throw new Error(
        [
          `error: GitHub did not sign commit ${i + 1} of ${plans.length} (${plan.sha.slice(0, 7)}, verification: ${commit.verification?.reason ?? "missing"}).`,
          `hint: signing needs a GitHub App installation token for '${repo}'. The branch was not changed.`,
          "To push unsigned instead, bypass the helper with:",
          bypass,
        ].join("\n"),
      );
    }
    newSha.set(plan.sha, commit.sha);
    newTree.set(plan.sha, commit.tree.sha);
    head = commit.sha;
    headTree = commit.tree.sha;
  }

  const localTree = gitOk(cwd, ["rev-parse", "HEAD^{tree}"]);
  if (headTree !== localTree) {
    throw new Error(
      `error: tree mismatch after replay: ${head} has tree ${headTree}, local HEAD has ${localTree}. ` +
        `${remote}/${branch} was not changed; your worktree was not changed.`,
    );
  }

  try {
    if (isNew) {
      await api("POST", `${repoPath}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: head,
      });
    } else {
      await api("PATCH", `${repoPath}/git/refs/heads/${refPath(branch)}`, {
        sha: head,
        force: false,
      });
    }
  } catch (err) {
    // Only these two messages are the race; other 422s (protected branch,
    // bad ref name, unreachable sha) cannot be fixed by fetching and retrying.
    if (
      err instanceof ApiError &&
      err.status === 422 &&
      /Update is not a fast forward|Reference already exists/i.test(err.message)
    ) {
      rejected();
    }
    throw err;
  }

  gitOk(cwd, ["fetch", remote]);
  gitOk(cwd, ["reset", "--mixed", head]);
  if (args.setUpstream) {
    gitOk(cwd, [
      "branch",
      `--set-upstream-to=${remote}/${branch}`,
      current || branch,
    ]);
  }
  return {
    message:
      `Pushed ${plans.length} signed commit(s) to ${remote}/${branch}. ` +
      `Note: commit SHAs changed (the API re-created them); your local branch now points at ${head}.`,
  };
}

if (import.meta.main) {
  try {
    const { message } = await signedPush({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
      fetch,
    });
    console.log(message);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
