import { describe, expect, test } from "bun:test";
import {
  ApiError,
  classifyDiff,
  createApiClient,
  DEFAULT_MAX_BYTES,
  parseArgs,
  parseRepoSlug,
  Refusal,
  readMaxBytes,
  refusalMessage,
  resolveBranch,
} from "./signed-push.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

function raw(...entries: [string, string, string, string, string][]): string {
  return entries
    .map(
      ([om, nm, status, path, sha]) =>
        `:${om} ${nm} ${om === "000000" ? ZERO : SHA_A} ${nm === "000000" ? ZERO : sha} ${status}\0${path}\0`,
    )
    .join("");
}

describe("classifyDiff", () => {
  test("added and modified regular files become additions", () => {
    const out = classifyDiff(
      raw(
        ["000000", "100644", "A", "new.txt", SHA_B],
        ["100644", "100644", "M", "dir/mod.txt", SHA_B],
      ),
    );
    expect(out.problems).toEqual([]);
    expect(out.additions).toEqual([
      { path: "new.txt", sha: SHA_B, mode: "100644" },
      { path: "dir/mod.txt", sha: SHA_B, mode: "100644" },
    ]);
    expect(out.deletions).toEqual([]);
  });

  test("deletions are listed by path", () => {
    const out = classifyDiff(raw(["100644", "000000", "D", "gone.txt", ZERO]));
    expect(out.deletions).toEqual(["gone.txt"]);
    expect(out.additions).toEqual([]);
    expect(out.problems).toEqual([]);
  });

  test("a rename (as emitted with --no-renames) is delete plus add", () => {
    const out = classifyDiff(
      raw(
        ["100644", "000000", "D", "old.txt", ZERO],
        ["000000", "100644", "A", "new.txt", SHA_B],
      ),
    );
    expect(out.deletions).toEqual(["old.txt"]);
    expect(out.additions).toEqual([
      { path: "new.txt", sha: SHA_B, mode: "100644" },
    ]);
  });

  test("new executable files are a problem", () => {
    const out = classifyDiff(raw(["000000", "100755", "A", "run.sh", SHA_B]));
    expect(out.problems.join()).toContain("executable");
    expect(out.problems.join()).toContain("run.sh");
  });

  test("mode changes are a problem", () => {
    const out = classifyDiff(raw(["100644", "100755", "M", "x.sh", SHA_B]));
    expect(out.problems.join()).toContain("mode change");
    const t = classifyDiff(raw(["100644", "120000", "T", "x", SHA_B]));
    expect(t.problems.length).toBeGreaterThan(0);
  });

  test("modifying an already-executable file is fine", () => {
    const out = classifyDiff(raw(["100755", "100755", "M", "x.sh", SHA_B]));
    expect(out.problems).toEqual([]);
    expect(out.additions).toEqual([
      { path: "x.sh", sha: SHA_B, mode: "100755" },
    ]);
  });

  test("symlinks and submodules are problems", () => {
    expect(
      classifyDiff(
        raw(["000000", "120000", "A", "link", SHA_B]),
      ).problems.join(),
    ).toContain("symlink");
    expect(
      classifyDiff(
        raw(["000000", "160000", "A", "sub", SHA_B]),
      ).problems.join(),
    ).toContain("submodule");
  });

  test("handles empty diffs and paths with spaces", () => {
    expect(classifyDiff("")).toEqual({
      additions: [],
      deletions: [],
      problems: [],
    });
    const out = classifyDiff(raw(["000000", "100644", "A", "a b.txt", SHA_B]));
    expect(out.additions[0]?.path).toBe("a b.txt");
  });
});

describe("parseArgs", () => {
  test("remote, refspec and -u", () => {
    expect(parseArgs(["-u", "origin", "feat/x"])).toMatchObject({
      remote: "origin",
      refspecs: ["feat/x"],
      setUpstream: true,
    });
    expect(parseArgs(["--set-upstream", "origin"]).setUpstream).toBe(true);
  });

  test("flags that need refusing are recorded", () => {
    expect(parseArgs(["--force", "origin", "x"]).force).toBe(true);
    expect(parseArgs(["-f", "origin"]).force).toBe(true);
    expect(parseArgs(["--force-with-lease", "origin"]).force).toBe(true);
    expect(parseArgs(["--force-with-lease=x:y", "origin"]).force).toBe(true);
    expect(parseArgs(["--tags", "origin"]).tags).toBe(true);
    expect(parseArgs(["--delete", "origin", "x"]).delete).toBe(true);
    expect(parseArgs(["-d", "origin", "x"]).delete).toBe(true);
    expect(parseArgs(["--all", "origin"]).all).toBe(true);
    expect(parseArgs(["--mirror", "origin"]).all).toBe(true);
  });

  test("benign flags are ignored", () => {
    expect(parseArgs(["-q", "--no-verify", "origin", "x"])).toMatchObject({
      remote: "origin",
      refspecs: ["x"],
    });
  });
});

describe("resolveBranch", () => {
  const base = parseArgs([]);
  test("defaults to the current branch", () => {
    expect(resolveBranch(parseArgs(["origin"]), "feat/x")).toBe("feat/x");
    expect(resolveBranch(base, "feat/x")).toBe("feat/x");
  });
  test("src:dst pushes HEAD to dst", () => {
    expect(resolveBranch(parseArgs(["origin", "HEAD:other"]), "feat/x")).toBe(
      "other",
    );
    expect(
      resolveBranch(parseArgs(["origin", "feat/x:refs/heads/other"]), "feat/x"),
    ).toBe("other");
    expect(resolveBranch(parseArgs(["origin", "HEAD"]), "feat/x")).toBe(
      "feat/x",
    );
  });
  test("force prefix, tag refs, deletes and foreign sources are refused", () => {
    for (const spec of ["+feat/x", ":feat/x", "HEAD:refs/tags/v1", "other:x"]) {
      expect(() =>
        resolveBranch(parseArgs(["origin", spec]), "feat/x"),
      ).toThrow(Refusal);
    }
  });
  test("detached HEAD without a refspec is refused", () => {
    expect(() => resolveBranch(base, undefined)).toThrow(Refusal);
  });
  test("several refspecs are refused", () => {
    expect(() => resolveBranch(parseArgs(["origin", "a", "b"]), "a")).toThrow(
      Refusal,
    );
  });
});

describe("refusalMessage", () => {
  test("teaches and ends with the bypass hint using the original args", () => {
    const msg = refusalMessage("new executable file run.sh", [
      "-u",
      "origin",
      "feat/x",
    ]);
    expect(msg).toContain("run.sh");
    expect(
      msg
        .trimEnd()
        .endsWith("SHIPWRIGHT_SIGNED_COMMITS=off git push -u origin feat/x"),
    ).toBe(true);
  });
});

describe("createApiClient", () => {
  test("sends bearer auth and JSON, parses the response", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const call = createApiClient({
      token: "tok",
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ ok: 1 }));
      }) as unknown as typeof fetch,
    });
    expect(
      await call<unknown>("POST", "/repos/a/b/git/trees", { x: 1 }),
    ).toEqual({
      ok: 1,
    });
    expect(seen?.url).toBe("https://api.github.com/repos/a/b/git/trees");
    expect(new Headers(seen?.init.headers).get("authorization")).toBe(
      "Bearer tok",
    );
    expect(seen?.init.body).toBe('{"x":1}');
  });
  test("non-2xx throws ApiError carrying the status and message", async () => {
    const call = createApiClient({
      token: "t",
      fetch: (async () =>
        new Response(JSON.stringify({ message: "nope" }), {
          status: 422,
        })) as unknown as typeof fetch,
    });
    const err = (await call("PATCH", "/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("nope");
  });
});

describe("readMaxBytes / parseRepoSlug", () => {
  test("default and override", () => {
    expect(readMaxBytes({})).toBe(DEFAULT_MAX_BYTES);
    expect(readMaxBytes({ SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES: "1234" })).toBe(
      1234,
    );
    expect(readMaxBytes({ SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES: "nope" })).toBe(
      DEFAULT_MAX_BYTES,
    );
  });
  test("github remote urls", () => {
    expect(parseRepoSlug("https://github.com/acme/widgets.git")).toBe(
      "acme/widgets",
    );
    expect(parseRepoSlug("https://github.com/acme/widgets")).toBe(
      "acme/widgets",
    );
    expect(parseRepoSlug("git@github.com:acme/widgets.git")).toBe(
      "acme/widgets",
    );
    expect(parseRepoSlug("/tmp/local")).toBeUndefined();
  });
});
