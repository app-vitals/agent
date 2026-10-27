import { describe, expect, test } from "bun:test";
import {
  ApiError,
  classifyDiff,
  createApiClient,
  DEFAULT_MAX_BYTES,
  deletionEntry,
  entryType,
  mapParents,
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
    expect(out.additions).toEqual([
      { path: "new.txt", sha: SHA_B, mode: "100644" },
      { path: "dir/mod.txt", sha: SHA_B, mode: "100644" },
    ]);
    expect(out.deletions).toEqual([]);
  });

  test("deletions keep their previous mode", () => {
    const out = classifyDiff(
      raw(
        ["100644", "000000", "D", "gone.txt", ZERO],
        ["160000", "000000", "D", "sub", ZERO],
      ),
    );
    expect(out.deletions).toEqual([
      { path: "gone.txt", mode: "100644" },
      { path: "sub", mode: "160000" },
    ]);
    expect(out.additions).toEqual([]);
  });

  test("a rename (as emitted with --no-renames) is delete plus add", () => {
    const out = classifyDiff(
      raw(
        ["100644", "000000", "D", "old.txt", ZERO],
        ["000000", "100644", "A", "new.txt", SHA_B],
      ),
    );
    expect(out.deletions).toEqual([{ path: "old.txt", mode: "100644" }]);
    expect(out.additions).toEqual([
      { path: "new.txt", sha: SHA_B, mode: "100644" },
    ]);
  });

  test("new executables and mode changes keep the real mode", () => {
    const out = classifyDiff(
      raw(
        ["000000", "100755", "A", "run.sh", SHA_B],
        ["100644", "100755", "M", "x.sh", SHA_B],
        ["100755", "100644", "M", "y.sh", SHA_B],
      ),
    );
    expect(out.additions.map((a) => [a.path, a.mode])).toEqual([
      ["run.sh", "100755"],
      ["x.sh", "100755"],
      ["y.sh", "100644"],
    ]);
  });

  test("symlinks, type changes and submodules keep their modes", () => {
    const out = classifyDiff(
      raw(
        ["000000", "120000", "A", "link", SHA_B],
        ["100644", "120000", "T", "was-file", SHA_B],
        ["000000", "160000", "A", "sub", SHA_B],
        ["160000", "160000", "M", "sub2", SHA_B],
      ),
    );
    expect(out.additions.map((a) => [a.path, a.mode])).toEqual([
      ["link", "120000"],
      ["was-file", "120000"],
      ["sub", "160000"],
      ["sub2", "160000"],
    ]);
  });

  test("handles empty diffs and paths with spaces", () => {
    expect(classifyDiff("")).toEqual({ additions: [], deletions: [] });
    const out = classifyDiff(raw(["000000", "100644", "A", "a b.txt", SHA_B]));
    expect(out.additions[0]?.path).toBe("a b.txt");
  });
});

describe("tree entries", () => {
  test("submodules are commit entries, everything else is a blob", () => {
    expect(entryType("160000")).toBe("commit");
    for (const m of ["100644", "100755", "120000"]) {
      expect(entryType(m)).toBe("blob");
    }
  });

  test("deletes are sha null with the old mode and type", () => {
    expect(deletionEntry({ path: "a", mode: "100755" })).toEqual({
      path: "a",
      mode: "100755",
      type: "blob",
      sha: null,
    });
    expect(deletionEntry({ path: "sub", mode: "160000" })).toEqual({
      path: "sub",
      mode: "160000",
      type: "commit",
      sha: null,
    });
  });
});

describe("mapParents", () => {
  test("replayed parents map to their new sha, others are kept as-is", () => {
    const map = new Map([["c1", "n1"]]);
    expect(mapParents(["c1", "onremote"], map)).toEqual(["n1", "onremote"]);
  });

  test("root commits have no parents", () => {
    expect(mapParents([], new Map())).toEqual([]);
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
