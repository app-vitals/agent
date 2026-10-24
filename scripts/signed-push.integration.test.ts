import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Refusal, signedPush } from "./signed-push.ts";

const FIXTURE_ERROR = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "signed-push-graphql-error.json"),
    "utf8",
  ),
);

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
  failCommitNumber?: number;
  dropFileFromTree?: string;
}

/**
 * Stands in for api.github.com/graphql: answers the helper's four operations
 * by applying them to a bare repo, and records every request.
 */
function fakeGitHub(bare: string, opts: FakeOptions = {}) {
  const requests: {
    query: string;
    variables: { input: { name: string; oid: string } };
    auth: string | null;
  }[] = [];
  let commits = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    requests.push({
      query: body.query,
      variables: body.variables,
      auth: headers.get("authorization"),
    });
    const json = (data: unknown) => new Response(JSON.stringify(data));
    const q: string = body.query;
    if (q.includes("RepoState")) {
      const branch = String(body.variables.ref).replace("refs/heads/", "");
      let ref: string | null = null;
      try {
        ref = git(bare, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      } catch {}
      const def = git(bare, ["rev-parse", "refs/heads/main"]);
      return json({
        data: {
          repository: {
            id: "R_1",
            defaultBranchRef: { name: "main", target: { oid: def } },
            ref: ref ? { target: { oid: ref } } : null,
          },
        },
      });
    }
    if (q.includes("CreateRef")) {
      const { name, oid } = body.variables.input;
      git(bare, ["update-ref", name, oid]);
      return json({ data: { createRef: { ref: { name } } } });
    }
    if (q.includes("CreateCommit")) {
      commits++;
      if (opts.failCommitNumber === commits) return json(FIXTURE_ERROR);
      const input = body.variables.input;
      const ref = `refs/heads/${input.branch.branchName}`;
      const head = git(bare, ["rev-parse", ref]);
      if (head !== input.expectedHeadOid) return json(FIXTURE_ERROR);
      const idx = join(bare, `fake-index-${commits}`);
      const env = { GIT_INDEX_FILE: idx };
      git(bare, ["read-tree", head], env);
      for (const d of input.fileChanges.deletions ?? []) {
        Bun.spawnSync(["git", "update-index", "--index-info"], {
          cwd: bare,
          env: { ...process.env, ...env },
          stdin: Buffer.from(`0 ${"0".repeat(40)}\t${d.path}\n`),
        });
      }
      for (const a of input.fileChanges.additions ?? []) {
        if (a.path === opts.dropFileFromTree) continue;
        const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
          cwd: bare,
          stdin: Buffer.from(a.contents, "base64"),
        })
          .stdout.toString()
          .trim();
        git(
          bare,
          ["update-index", "--add", "--cacheinfo", `100644,${blob},${a.path}`],
          env,
        );
      }
      const tree = git(bare, ["write-tree"], env);
      rmSync(idx);
      const msg = input.message.body
        ? `${input.message.headline}\n\n${input.message.body}\n`
        : `${input.message.headline}\n`;
      const c = Bun.spawnSync(
        ["git", "commit-tree", tree, "-p", head, "-F", "-"],
        {
          cwd: bare,
          stdin: Buffer.from(msg),
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "app[bot]",
            GIT_AUTHOR_EMAIL: "app@users.noreply.github.com",
            GIT_COMMITTER_NAME: "GitHub",
            GIT_COMMITTER_EMAIL: "noreply@github.com",
          },
        },
      )
        .stdout.toString()
        .trim();
      git(bare, ["update-ref", ref, c]);
      return json({ data: { createCommitOnBranch: { commit: { oid: c } } } });
    }
    if (q.includes("CommitTree")) {
      const oid = body.variables.oid;
      return json({
        data: {
          repository: {
            object: {
              tree: { oid: git(bare, ["rev-parse", `${oid}^{tree}`]) },
            },
          },
        },
      });
    }
    return new Response("unexpected query", { status: 500 });
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
    // new branch -> ref created at the merge-base
    const createRef = gh.requests.find((r) => r.query.includes("CreateRef"));
    expect(createRef?.variables.input.name).toBe("refs/heads/feat/x");
    expect(createRef?.variables.input.oid).toBe(
      git(work, ["rev-parse", "origin/main"]),
    );
  });

  test("pushing to an existing branch does not create a ref", async () => {
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
    expect(gh.requests.some((r) => r.query.includes("CreateRef"))).toBe(false);
    expect(git(bare, ["rev-list", "--count", "main..feat/x"])).toBe("1");
  });

  test("mid-replay failure reports landed commits and leaves the worktree", async () => {
    commitTwo();
    const oldHead = git(work, ["rev-parse", "HEAD"]);
    const gh = fakeGitHub(bare, { failCommitNumber: 2 });
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
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("1 of 2 commits");
    expect(msg).toContain("git fetch");
    expect(msg).toContain("rebase");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(oldHead);
    expect(git(bare, ["rev-list", "--count", "main..feat/x"])).toBe("1");
  });

  test("tree mismatch aborts before touching the worktree", async () => {
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
    expect(git(work, ["rev-parse", "HEAD"])).toBe(oldHead);
  });

  test("refuses a new executable file with the bypass hint, no API calls", async () => {
    writeFileSync(join(work, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "feat: script"]);
    const gh = fakeGitHub(bare);
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
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toContain("run.sh");
    expect((err as Error).message.trimEnd()).toEndWith(
      "SHIPWRIGHT_SIGNED_COMMITS=off git push origin feat/x",
    );
    expect(git(bare, ["branch", "--list", "feat/x"])).toBe("");
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
    ).rejects.toThrow(/non-fast-forward/);
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
