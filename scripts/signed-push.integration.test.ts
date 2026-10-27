import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushRejected, Refusal, signedPush } from "./signed-push.ts";

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      ...env,
    },
  });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  }
  return p.stdout.toString().trim();
}

interface FakeOptions {
  /** Commits come back with verification.verified = false. */
  unsigned?: boolean;
  /** Leave this path out of every created tree. */
  dropFileFromTree?: string;
  /** Runs right before the ref is moved (simulates a concurrent push). */
  beforeRefMove?: () => void;
}

interface Recorded {
  method: string;
  path: string;
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON request body
  body: Record<string, any>;
  auth: string | null;
}

/**
 * Stands in for the REST Git Data API on api.github.com: applies blob, tree,
 * commit and ref requests to a bare repo and records every request.
 */
function fakeGitHub(bare: string, opts: FakeOptions = {}) {
  const requests: Recorded[] = [];
  const respond = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status });
  const hash = (data: Buffer) =>
    Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
      cwd: bare,
      stdin: data,
    })
      .stdout.toString()
      .trim();
  let n = 0;

  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON request body
    const body: Record<string, any> = init.body
      ? JSON.parse(String(init.body))
      : {};
    requests.push({
      method,
      path,
      body,
      auth: new Headers(init.headers).get("authorization"),
    });
    const p = path.replace("/repos/acme/widgets", "");

    if (method === "GET" && p === "") {
      return respond(200, { default_branch: "main" });
    }
    if (method === "GET" && p.startsWith("/git/ref/heads/")) {
      try {
        const sha = git(bare, [
          "rev-parse",
          "--verify",
          `refs/heads/${p.slice("/git/ref/heads/".length)}`,
        ]);
        return respond(200, { object: { sha } });
      } catch {
        return respond(404, { message: "Not Found" });
      }
    }
    if (method === "POST" && p === "/git/blobs") {
      return respond(201, {
        sha: hash(Buffer.from(body.content, body.encoding)),
      });
    }
    if (method === "POST" && p === "/git/trees") {
      const idx = join(bare, `fake-index-${++n}`);
      const env = { GIT_INDEX_FILE: idx };
      if (body.base_tree) git(bare, ["read-tree", body.base_tree], env);
      for (const e of body.tree) {
        if (e.path === opts.dropFileFromTree) continue;
        if (e.sha === null) {
          Bun.spawnSync(["git", "update-index", "--index-info"], {
            cwd: bare,
            env: { ...process.env, ...env },
            stdin: Buffer.from(`0 ${"0".repeat(40)}\t${e.path}\n`),
          });
          continue;
        }
        const sha = e.sha ?? hash(Buffer.from(e.content));
        git(
          bare,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `${e.mode},${sha},${e.path}`,
          ],
          env,
        );
      }
      const sha = git(bare, ["write-tree"], env);
      rmSync(idx);
      return respond(201, { sha });
    }
    if (method === "POST" && p === "/git/commits") {
      const args = ["commit-tree", body.tree];
      for (const parent of body.parents) args.push("-p", parent);
      const c = Bun.spawnSync(["git", ...args, "-F", "-"], {
        cwd: bare,
        stdin: Buffer.from(body.message),
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "app[bot]",
          GIT_AUTHOR_EMAIL: "app@users.noreply.github.com",
          GIT_COMMITTER_NAME: "GitHub",
          GIT_COMMITTER_EMAIL: "noreply@github.com",
        },
      })
        .stdout.toString()
        .trim();
      return respond(201, {
        sha: c,
        tree: { sha: body.tree },
        verification: opts.unsigned
          ? { verified: false, reason: "unsigned" }
          : { verified: true, reason: "valid" },
      });
    }
    if (method === "POST" && p === "/git/refs") {
      opts.beforeRefMove?.();
      try {
        git(bare, ["rev-parse", "--verify", body.ref]);
        return respond(422, { message: "Reference already exists" });
      } catch {}
      git(bare, ["update-ref", body.ref, body.sha]);
      return respond(201, { ref: body.ref });
    }
    if (method === "PATCH" && p.startsWith("/git/refs/heads/")) {
      opts.beforeRefMove?.();
      const ref = `refs/heads/${p.slice("/git/refs/heads/".length)}`;
      const cur = git(bare, ["rev-parse", ref]);
      const ff = Bun.spawnSync(
        ["git", "merge-base", "--is-ancestor", cur, body.sha],
        { cwd: bare },
      ).exitCode;
      if (body.force !== true && ff !== 0) {
        return respond(422, { message: "Update is not a fast forward" });
      }
      git(bare, ["update-ref", ref, body.sha]);
      return respond(200, { ref });
    }
    return respond(500, { message: `unexpected ${method} ${path}` });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, requests };
}

let root: string;
let bare: string;
let work: string;
let tokenFile: string;

function env(extra: Record<string, string> = {}) {
  return {
    SHIPWRIGHT_GH_OWNER: "Acme",
    GH_TOKEN_FILE: tokenFile,
    ...extra,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "signed-push-"));
  bare = join(root, "remote.git");
  work = join(root, "work");
  const seed = join(root, "seed");
  git(root, ["init", "--bare", "-b", "main", bare]);
  git(root, ["init", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(join(seed, "old.txt"), "to be renamed\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["push", bare, "main"]);
  git(root, ["clone", bare, work]);
  git(work, ["checkout", "-b", "feat/x"]);
  mkdirSync(join(root, "gh-token.d"));
  tokenFile = join(root, "gh-token");
  writeFileSync(tokenFile, "default-token");
  writeFileSync(join(root, "gh-token.d", "acme"), "acme-token\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function commitTwo() {
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, ["mv", "old.txt", "renamed.txt"]);
  git(work, ["add", "."]);
  git(work, [
    "commit",
    "-m",
    "feat: first\n\nSome body\n\nCo-Authored-By: Pair <pair@example.com>",
  ]);
  writeFileSync(join(work, "a.txt"), "one\ntwo\n");
  git(work, ["commit", "-am", "fix: second"]);
}

describe("signedPush", () => {
  test("replays each commit, keeps messages, syncs worktree with reset --mixed", async () => {
    commitTwo();
    writeFileSync(join(work, "wip.txt"), "uncommitted\n");
    writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\n");
    const oldHead = git(work, ["rev-parse", "HEAD"]);
    const gh = fakeGitHub(bare);

    const result = await signedPush({
      argv: ["-u", "origin", "feat/x"],
      env: env(),
      cwd: work,
      fetch: gh.fetch,
      repo: "acme/widgets",
    });

    const remoteHead = git(bare, ["rev-parse", "refs/heads/feat/x"]);
    const log = git(bare, ["log", "--format=%an|%s", "main..feat/x"]);
    expect(log).toBe("app[bot]|fix: second\napp[bot]|feat: first");
    expect(
      git(bare, ["log", "-1", "--format=%B", `${remoteHead}~1`]),
    ).toContain("Co-Authored-By: Pair <pair@example.com>");
    expect(git(bare, ["rev-list", "--count", "main..feat/x"])).toBe("2");
    // worktree sits on the remote head, uncommitted work survives
    expect(git(work, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(git(work, ["rev-parse", "HEAD"])).not.toBe(oldHead);
    expect(readFileSync(join(work, "wip.txt"), "utf8")).toBe("uncommitted\n");
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(git(work, ["rev-parse", "--abbrev-ref", "feat/x@{upstream}"])).toBe(
      "origin/feat/x",
    );
    expect(result.message).toContain("SHAs");
    // per-owner token, lowercased owner, trailing newline trimmed
    expect(gh.requests.every((r) => r.auth === "Bearer acme-token")).toBe(true);
    // REST only, ref created once, after every commit, at the final signed commit
    expect(
      gh.requests.every((r) => r.path.startsWith("/repos/acme/widgets")),
    ).toBe(true);
    const refCalls = gh.requests.filter((r) => r.path.includes("/git/refs"));
    expect(refCalls).toHaveLength(1);
    expect(gh.requests.at(-1)).toBe(refCalls[0]);
    expect(refCalls[0]?.method).toBe("POST");
    expect(refCalls[0]?.body).toEqual({
      ref: "refs/heads/feat/x",
      sha: remoteHead,
    });
    // no author/committer so GitHub signs
    for (const c of gh.requests.filter((r) =>
      r.path.endsWith("/git/commits"),
    )) {
      expect(c.body).not.toHaveProperty("author");
      expect(c.body).not.toHaveProperty("committer");
    }
  });

  test("pushing to an existing branch PATCHes the ref without force", async () => {
    git(bare, ["update-ref", "refs/heads/feat/x", "refs/heads/main"]);
    git(work, ["fetch", "origin"]);
    git(work, ["reset", "--hard", "origin/feat/x"]);
    writeFileSync(join(work, "n.txt"), "n\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "feat: n"]);
    const gh = fakeGitHub(bare);
    await signedPush({
      argv: ["origin", "feat/x"],
      env: env(),
      cwd: work,
      fetch: gh.fetch,
      repo: "acme/widgets",
    });
    expect(
      gh.requests.some(
        (r) => r.method === "POST" && r.path.endsWith("/git/refs"),
      ),
    ).toBe(false);
    const patch = gh.requests.filter((r) => r.method === "PATCH");
    expect(patch).toHaveLength(1);
    expect(patch[0]?.path).toBe("/repos/acme/widgets/git/refs/heads/feat/x");
    expect(patch[0]?.body.force).toBe(false);
    expect(git(bare, ["rev-list", "--count", "main..feat/x"])).toBe("1");
  });

  test("an unverified commit aborts before the ref moves, with hint and bypass", async () => {
    commitTwo();
    const oldHead = git(work, ["rev-parse", "HEAD"]);
    const gh = fakeGitHub(bare, { unsigned: true });
    let err: unknown;
    try {
      await signedPush({
        argv: ["origin", "feat/x"],
        env: env(),
        cwd: work,
        fetch: gh.fetch,
        repo: "acme/widgets",
      });
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    expect(msg).toContain("did not sign");
    expect(msg).toContain("unsigned");
    expect(msg.trimEnd()).toEndWith(
      "SHIPWRIGHT_SIGNED_COMMITS=off git push origin feat/x",
    );
    expect(gh.requests.some((r) => r.path.includes("/git/refs"))).toBe(false);
    expect(git(bare, ["branch", "--list", "feat/x"])).toBe("");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(oldHead);
  });

  test("tree mismatch aborts before the ref moves or the worktree changes", async () => {
    commitTwo();
    const oldHead = git(work, ["rev-parse", "HEAD"]);
    const gh = fakeGitHub(bare, { dropFileFromTree: "a.txt" });
    await expect(
      signedPush({
        argv: ["origin", "feat/x"],
        env: env(),
        cwd: work,
        fetch: gh.fetch,
        repo: "acme/widgets",
      }),
    ).rejects.toThrow(/tree/i);
    expect(gh.requests.some((r) => r.path.includes("/git/refs"))).toBe(false);
    expect(git(bare, ["branch", "--list", "feat/x"])).toBe("");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(oldHead);
  });

  test("a non-ff race on the ref update prints git-style rejection", async () => {
    git(bare, ["update-ref", "refs/heads/feat/x", "refs/heads/main"]);
    git(work, ["fetch", "origin"]);
    git(work, ["reset", "--hard", "origin/feat/x"]);
    writeFileSync(join(work, "n.txt"), "n\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "feat: n"]);
    const oldHead = git(work, ["rev-parse", "HEAD"]);
    const gh = fakeGitHub(bare, {
      beforeRefMove: () => {
        const tree = git(bare, ["rev-parse", "main^{tree}"]);
        const other = git(
          bare,
          ["commit-tree", tree, "-p", "main", "-m", "raced"],
          {
            GIT_AUTHOR_NAME: "o",
            GIT_AUTHOR_EMAIL: "o@example.com",
            GIT_COMMITTER_NAME: "o",
            GIT_COMMITTER_EMAIL: "o@example.com",
          },
        );
        git(bare, ["update-ref", "refs/heads/feat/x", other]);
      },
    });
    let err: unknown;
    try {
      await signedPush({
        argv: ["origin", "feat/x"],
        env: env(),
        cwd: work,
        fetch: gh.fetch,
        repo: "acme/widgets",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PushRejected);
    const lines = (err as Error).message.split("\n");
    expect(lines[0]).toContain("! [rejected]");
    expect(lines[0]).toContain("feat/x -> feat/x (fetch first)");
    expect(lines[1]).toBe(`error: failed to push some refs to '${bare}'`);
    expect(git(work, ["rev-parse", "HEAD"])).toBe(oldHead);
  });

  test("pushes a new executable, a symlink and a submodule pointer with exact modes", async () => {
    writeFileSync(join(work, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("README.md", join(work, "link"));
    git(work, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"1".repeat(40)},vendor/sub`,
    ]);
    git(work, ["add", "run.sh", "link"]);
    git(work, ["commit", "-m", "feat: modes"]);
    git(work, ["update-index", "--chmod=+x", "README.md"]);
    git(work, ["commit", "-m", "chore: chmod"]);
    const localTree = git(work, ["rev-parse", "HEAD^{tree}"]);
    const gh = fakeGitHub(bare);
    await signedPush({
      argv: ["origin", "feat/x"],
      env: env(),
      cwd: work,
      fetch: gh.fetch,
      repo: "acme/widgets",
    });
    expect(git(bare, ["rev-parse", "feat/x^{tree}"])).toBe(localTree);
    const ls = git(bare, ["ls-tree", "-r", "feat/x"]);
    expect(ls).toContain("100755 blob");
    expect(ls).toMatch(/120000 blob \w+\tlink/);
    expect(ls).toMatch(
      new RegExp(`160000 commit ${"1".repeat(40)}\\tvendor/sub`),
    );
    expect(ls).toMatch(/100755 blob \w+\tREADME.md/);
  });

  test("a merge of main with a second parent from the base keeps both parents", async () => {
    // feature branch diverges, main moves on (and is on the remote), then main
    // is merged into the feature branch with a resolved conflict.
    writeFileSync(join(work, "README.md"), "feature\n");
    git(work, ["commit", "-am", "feat: readme"]);
    const other = join(root, "other");
    git(root, ["clone", bare, other]);
    writeFileSync(join(other, "README.md"), "main\n");
    git(other, ["commit", "-am", "main: readme"]);
    git(other, ["push", "origin", "main"]);
    git(work, ["fetch", "origin"]);
    const mainTip = git(work, ["rev-parse", "origin/main"]);
    // The merge conflicts on README.md; its non-zero exit is expected.
    expect(() =>
      git(work, ["merge", "origin/main", "-m", "merge main"]),
    ).toThrow();
    writeFileSync(join(work, "README.md"), "resolved\n");
    git(work, ["commit", "-am", "merge main"]);
    expect(
      git(work, ["rev-list", "--parents", "-n1", "HEAD"]).split(" "),
    ).toHaveLength(3);
    const localTree = git(work, ["rev-parse", "HEAD^{tree}"]);
    const gh = fakeGitHub(bare);
    await signedPush({
      argv: ["origin", "feat/x"],
      env: env(),
      cwd: work,
      fetch: gh.fetch,
      repo: "acme/widgets",
    });
    const tip = git(bare, ["rev-parse", "feat/x"]);
    const parents = git(bare, ["rev-list", "--parents", "-n1", tip]).split(" ");
    expect(parents).toHaveLength(3);
    // first parent is the replayed feature commit, second is main's real tip
    expect(parents[2]).toBe(mainTip);
    expect(git(bare, ["rev-parse", `${tip}^{tree}`])).toBe(localTree);
    // main's own commit was not replayed
    expect(git(bare, ["rev-list", "--count", "main..feat/x"])).toBe("2");
    expect(git(bare, ["show", `${tip}:README.md`])).toBe("resolved");
  });

  test("a merge from main uploads no blobs main already has, and binary uses the blob API", async () => {
    writeFileSync(join(work, "mine.txt"), "mine\n");
    writeFileSync(join(work, "mine.bin"), Buffer.from([0, 1, 2, 3]));
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "feat: mine"]);
    const other = join(root, "other");
    git(root, ["clone", bare, other]);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(other, `main-${i}.txt`), `main ${i}\n`);
      writeFileSync(join(other, `main-${i}.bin`), Buffer.from([0, i, 9]));
    }
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "main: files"]);
    git(other, ["push", "origin", "main"]);
    git(work, ["fetch", "origin"]);
    git(work, ["merge", "origin/main", "-m", "merge main"]);
    const localTree = git(work, ["rev-parse", "HEAD^{tree}"]);
    const gh = fakeGitHub(bare);
    await signedPush({
      argv: ["origin", "feat/x"],
      env: env(),
      cwd: work,
      fetch: gh.fetch,
      repo: "acme/widgets",
    });
    expect(git(bare, ["rev-parse", "feat/x^{tree}"])).toBe(localTree);
    const posts = (suffix: string) =>
      gh.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix));
    // Only the feature commit's binary file is uploaded as a blob.
    expect(posts("/git/blobs")).toHaveLength(1);
    const trees = posts("/git/trees");
    expect(trees).toHaveLength(2);
    const mergeTree = trees[1]?.body.tree as Record<string, unknown>[];
    expect(mergeTree).toHaveLength(10);
    for (const e of mergeTree) {
      expect(e.sha).toBeString();
      expect(e.content).toBeUndefined();
    }
    // 3 reads (branch ref, repo, default branch ref) + 1 blob + 2 trees +
    // 2 commits + 1 ref create.
    expect(gh.requests).toHaveLength(9);
    // Text in the feature commit went inline in its tree request.
    const first = trees[0]?.body.tree as Record<string, unknown>[];
    expect(first.find((e) => e.path === "mine.txt")?.content).toBe("mine\n");
  });

  test("a persistent rate limit fails with a git-style error naming the cause", async () => {
    commitTwo();
    const calls: string[] = [];
    const limited = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 403,
        headers: { "retry-after": "1" },
      });
    }) as unknown as typeof fetch;
    const err = (await signedPush({
      argv: ["origin", "feat/x"],
      env: env(),
      cwd: work,
      fetch: limited,
      repo: "acme/widgets",
      client: { sleep: async () => {}, maxRetries: 2 },
    }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(PushRejected);
    expect(err.message).toMatch(/rate-limited/);
    expect(err.message).toMatch(/failed to push some refs/);
    expect(calls).toHaveLength(3);
  });

  test("a root commit on unrelated history pushes with no parents", async () => {
    git(work, ["checkout", "--orphan", "unrelated"]);
    git(work, ["rm", "-rf", "."]);
    writeFileSync(join(work, "only.txt"), "alone\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "chore: unrelated root"]);
    const localTree = git(work, ["rev-parse", "HEAD^{tree}"]);
    const gh = fakeGitHub(bare);
    await signedPush({
      argv: ["origin", "unrelated"],
      env: env(),
      cwd: work,
      fetch: gh.fetch,
      repo: "acme/widgets",
    });
    expect(git(bare, ["rev-parse", "unrelated^{tree}"])).toBe(localTree);
    expect(
      git(bare, ["rev-list", "--parents", "-n1", "unrelated"]).split(" "),
    ).toHaveLength(1);
  });

  test("refuses payloads over the size cap", async () => {
    writeFileSync(join(work, "big.bin"), "x".repeat(5000));
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "feat: big"]);
    const gh = fakeGitHub(bare);
    await expect(
      signedPush({
        argv: ["origin", "feat/x"],
        env: env({ SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES: "1000" }),
        cwd: work,
        fetch: gh.fetch,
        repo: "acme/widgets",
      }),
    ).rejects.toThrow(/SHIPWRIGHT_SIGNED_COMMITS=off/);
  });

  test("refuses force, tags, delete and non-fast-forward", async () => {
    commitTwo();
    const gh = fakeGitHub(bare);
    for (const argv of [
      ["--force", "origin", "feat/x"],
      ["--tags", "origin"],
      ["--delete", "origin", "feat/x"],
    ]) {
      await expect(
        signedPush({
          argv,
          env: env(),
          cwd: work,
          fetch: gh.fetch,
          repo: "acme/widgets",
        }),
      ).rejects.toThrow(/SHIPWRIGHT_SIGNED_COMMITS=off git push/);
    }
    // remote branch has a commit the local one lacks
    git(bare, ["update-ref", "refs/heads/feat/x", "refs/heads/main"]);
    const other = join(root, "other");
    git(root, ["clone", bare, other]);
    git(other, ["checkout", "feat/x"]);
    writeFileSync(join(other, "z.txt"), "z\n");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "remote only"]);
    git(other, ["push", "origin", "feat/x"]);
    await expect(
      signedPush({
        argv: ["origin", "feat/x"],
        env: env(),
        cwd: work,
        fetch: gh.fetch,
        repo: "acme/widgets",
      }),
    ).rejects.toThrow(/\(fetch first\)/);
  });

  test("a non-race 422 on the ref update is rethrown, not reported as fetch first", async () => {
    commitTwo();
    const gh = fakeGitHub(bare);
    const wrapped = (async (url: string, init?: RequestInit) => {
      if (init?.method !== "GET" && /\/git\/refs(\/|$)/.test(String(url))) {
        return new Response(
          JSON.stringify({ message: "Protected branch update failed" }),
          { status: 422 },
        );
      }
      return gh.fetch(url, init);
    }) as unknown as typeof fetch;
    const err = await signedPush({
      argv: ["origin", "feat/x"],
      env: env(),
      cwd: work,
      fetch: wrapped,
      repo: "acme/widgets",
    }).catch((e) => e as Error);
    expect(err.message).toContain("Protected branch update failed");
    expect(err.message).not.toContain("fetch first");
  });

  test("missing owner token gives a clear error", async () => {
    commitTwo();
    const gh = fakeGitHub(bare);
    await expect(
      signedPush({
        argv: ["origin", "feat/x"],
        env: env({ SHIPWRIGHT_GH_OWNER: "nobody" }),
        cwd: work,
        fetch: gh.fetch,
        repo: "acme/widgets",
      }),
    ).rejects.toThrow(/nobody/);
  });
});
