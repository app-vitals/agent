#!/usr/bin/env bun
/**
 * scripts/signed-push.ts
 *
 * `git push` replacement for GitHub App agents. Commits pushed with plain git
 * are unsigned; commits created through the GraphQL `createCommitOnBranch`
 * mutation are signed by GitHub. This helper replays the local commits in
 * `<remoteHead>..HEAD` through that mutation using the per-owner installation
 * token, then verifies the remote tree equals the local `HEAD^{tree}` and only
 * then syncs the worktree (`git fetch` + `git reset --mixed <newhead>`, never
 * `--hard`: the trees are identical so uncommitted work survives).
 *
 * Token: `SHIPWRIGHT_GH_OWNER` selects `gh-token.d/<owner>`, a directory next
 * to the file at `$GH_TOKEN_FILE` (same convention as
 * scripts/bin/git-credential-shipwright.sh; owner validation shared with
 * runtime/gh-token-files.ts).
 *
 * The API cannot express some things, and a push the helper cannot reproduce
 * exactly must not silently differ, so it refuses (exit 1, message ending in
 * the `SHIPWRIGHT_SIGNED_COMMITS=off git push ...` bypass): new executable
 * files, mode changes, symlinks, submodules, force/tag/delete pushes,
 * non-fast-forward pushes, merge commits and oversized commits.
 *
 * Size cap: default 10 MB of base64 payload per commit, override with
 * `SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES`. NOT VERIFIED: GitHub does not
 * document a limit for createCommitOnBranch; this was written without network
 * access. The cap is a conservative guard on the GraphQL request body (the
 * API has been reported to reject very large request bodies), not a known
 * GitHub constant. Tune it if a real limit is observed.
 *
 * Usage: bun scripts/signed-push.ts [git push args...]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateOwner } from "../runtime/gh-token-files.ts";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const GRAPHQL_URL = "https://api.github.com/graphql";

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
}
export interface Classified {
  additions: Addition[];
  deletions: string[];
  problems: string[];
}

/**
 * Classify `git diff-tree -r -z --no-renames --raw` output. Renames never
 * appear (they arrive as delete + add). Problems list everything the commit
 * API cannot express.
 */
export function classifyDiff(raw: string): Classified {
  const out: Classified = { additions: [], deletions: [], problems: [] };
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
      out.deletions.push(path);
      continue;
    }
    if (newMode === "160000") {
      out.problems.push(`submodule change at ${path}`);
    } else if (newMode === "120000") {
      out.problems.push(`symlink at ${path}`);
    } else if (oldMode === "000000" && newMode === "100755") {
      out.problems.push(`new executable file ${path}`);
    } else if (oldMode !== "000000" && oldMode !== newMode) {
      out.problems.push(`mode change (${oldMode} -> ${newMode}) on ${path}`);
    } else {
      out.additions.push({ path, sha: newSha });
    }
  }
  return out;
}

export function splitMessage(message: string): {
  headline: string;
  body: string;
} {
  const trimmed = message.replace(/\s+$/, "");
  const nl = trimmed.indexOf("\n");
  if (nl === -1) return { headline: trimmed, body: "" };
  return {
    headline: trimmed.slice(0, nl),
    body: trimmed.slice(nl + 1).replace(/^\s*\n/, ""),
  };
}

export interface CommitInputParams {
  repo: string;
  branch: string;
  expectedHeadOid: string;
  message: string;
  additions: { path: string; contents: Buffer }[];
  deletions: string[];
}

/** Build the `CreateCommitOnBranchInput` object. */
export function buildCommitInput(p: CommitInputParams) {
  const { headline, body } = splitMessage(p.message);
  return {
    branch: { repositoryNameWithOwner: p.repo, branchName: p.branch },
    message: body ? { headline, body } : { headline },
    fileChanges: {
      additions: p.additions.map((a) => ({
        path: a.path,
        contents: a.contents.toString("base64"),
      })),
      deletions: p.deletions.map((path) => ({ path })),
    },
    expectedHeadOid: p.expectedHeadOid,
  };
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
// GraphQL client
// ---------------------------------------------------------------------------

export type GraphqlClient = <T>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>;

export function createGraphqlClient(opts: {
  fetch: typeof fetch;
  token: string;
  url?: string;
}): GraphqlClient {
  return async <T>(query: string, variables: Record<string, unknown>) => {
    const res = await opts.fetch(opts.url ?? GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
        "user-agent": "shipwright-signed-push",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: { data?: T; errors?: { message: string }[] };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `GitHub GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok || json.errors?.length) {
      const msg =
        json.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`GitHub GraphQL error: ${msg}`);
    }
    return json.data as T;
  };
}

const REPO_STATE = `query RepoState($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    id
    defaultBranchRef { name target { oid } }
    ref(qualifiedName: $ref) { target { oid } }
  }
}`;
const CREATE_REF = `mutation CreateRef($input: CreateRefInput!) {
  createRef(input: $input) { ref { name } }
}`;
const CREATE_COMMIT = `mutation CreateCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;
const COMMIT_TREE = `query CommitTree($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit { tree { oid } } }
  }
}`;

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
}

interface RepoState {
  repository: {
    id: string;
    defaultBranchRef: { name: string; target: { oid: string } } | null;
    ref: { target: { oid: string } } | null;
  };
}

export async function signedPush(
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

  const repo =
    opts.repo ?? parseRepoSlug(gitOk(cwd, ["remote", "get-url", remote]));
  if (!repo) {
    throw new Error(`signed-push: remote '${remote}' is not a github.com URL`);
  }
  const [owner, name] = repo.split("/") as [string, string];
  const gql = createGraphqlClient({ fetch: opts.fetch, token });

  const { repository } = await gql<RepoState>(REPO_STATE, {
    owner,
    name,
    ref: `refs/heads/${branch}`,
  });

  const hasObject = (oid: string) =>
    runGit(cwd, ["cat-file", "-e", `${oid}^{commit}`]).code === 0;
  const ensureObject = (oid: string) => {
    if (!hasObject(oid)) runGit(cwd, ["fetch", remote]);
    return hasObject(oid);
  };

  const remoteHead = repository.ref?.target.oid;
  const isNew = remoteHead === undefined;
  let base: string;
  if (remoteHead) {
    const nonFf = () =>
      refuse(
        `non-fast-forward: ${remote}/${branch} has commits your branch lacks (fetch and rebase first)`,
      );
    if (!ensureObject(remoteHead)) nonFf();
    if (
      runGit(cwd, ["merge-base", "--is-ancestor", remoteHead, "HEAD"]).code !==
      0
    )
      nonFf();
    base = remoteHead;
  } else {
    const def = repository.defaultBranchRef?.target.oid;
    if (!def || !ensureObject(def)) {
      return refuse(
        "cannot find the default branch to create the new branch from",
      );
    }
    const mb = runGit(cwd, ["merge-base", def, "HEAD"]);
    if (mb.code !== 0 || !mb.text) {
      return refuse("HEAD shares no history with the default branch");
    }
    base = mb.text;
  }

  const commits = gitOk(cwd, ["rev-list", "--reverse", `${base}..HEAD`])
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0 && !isNew) {
    return { message: "Everything up-to-date" };
  }

  // Validate every commit before any API call so a refusal changes nothing.
  const plans = commits.map((sha) => {
    const parents = gitOk(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(
      " ",
    );
    if (parents.length > 2) {
      refuse(`merge commit ${sha.slice(0, 7)} would be flattened`);
    }
    if (parents.length < 2) refuse(`root commit ${sha.slice(0, 7)}`);
    const diff = runGit(cwd, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--raw",
      `${sha}^`,
      sha,
    ]);
    const c = classifyDiff(diff.stdout.toString());
    if (c.problems.length) {
      refuse(`commit ${sha.slice(0, 7)}: ${c.problems.join("; ")}`);
    }
    let bytes = 0;
    const additions = c.additions.map((a) => {
      const contents = runGit(cwd, ["cat-file", "blob", a.sha]).stdout;
      bytes += Math.ceil((contents.length * 4) / 3);
      if (bytes > maxBytes) {
        refuse(
          `commit ${sha.slice(0, 7)} exceeds the ${maxBytes} byte payload cap (SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES)`,
        );
      }
      return { path: a.path, contents };
    });
    const message = gitOk(cwd, ["log", "-1", "--format=%B", sha]);
    return { sha, message, additions, deletions: c.deletions };
  });

  if (isNew) {
    await gql(CREATE_REF, {
      input: {
        repositoryId: repository.id,
        name: `refs/heads/${branch}`,
        oid: base,
      },
    });
  }

  let head = base;
  let landed = 0;
  for (const plan of plans) {
    try {
      const res = await gql<{
        createCommitOnBranch: { commit: { oid: string } };
      }>(CREATE_COMMIT, {
        input: buildCommitInput({
          repo,
          branch,
          expectedHeadOid: head,
          message: plan.message,
          additions: plan.additions,
          deletions: plan.deletions,
        }),
      });
      head = res.createCommitOnBranch.commit.oid;
      landed++;
    } catch (err) {
      throw new Error(
        `signed-push: failed on commit ${landed + 1} of ${plans.length} (${plan.sha.slice(0, 7)}): ${(err as Error).message}\n` +
          `${landed} of ${plans.length} commits landed on ${remote}/${branch} (head ${head}). ` +
          "Your worktree was not changed. Run `git fetch` and rebase your remaining local commits onto the remote branch, then push again.",
      );
    }
  }

  const tree = await gql<{
    repository: { object: { tree: { oid: string } } | null };
  }>(COMMIT_TREE, { owner, name, oid: head });
  const remoteTree = tree.repository.object?.tree.oid;
  const localTree = gitOk(cwd, ["rev-parse", "HEAD^{tree}"]);
  if (remoteTree !== localTree) {
    throw new Error(
      `signed-push: tree mismatch after replay: remote ${head} has tree ${remoteTree}, local HEAD has ${localTree}. ` +
        `${landed} of ${plans.length} commits landed on ${remote}/${branch}. Your worktree was not changed; ` +
        "inspect the remote branch, then `git fetch` and rebase.",
    );
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
      `Pushed ${landed} signed commit(s) to ${remote}/${branch}. ` +
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
