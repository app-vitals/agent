import { describe, expect, test } from "bun:test";
import {
  buildCommitInput,
  classifyDiff,
  DEFAULT_MAX_BYTES,
  parseArgs,
  parseRepoSlug,
  Refusal,
  readMaxBytes,
  refusalMessage,
  resolveBranch,
  splitMessage,
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
      { path: "new.txt", sha: SHA_B },
      { path: "dir/mod.txt", sha: SHA_B },
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
    expect(out.additions).toEqual([{ path: "new.txt", sha: SHA_B }]);
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
    expect(out.additions).toHaveLength(1);
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

describe("splitMessage", () => {
  test("headline and body keep trailers", () => {
    expect(
      splitMessage("feat: x\n\nbody line\n\nCo-Authored-By: A <a@b.c>\n"),
    ).toEqual({
      headline: "feat: x",
      body: "body line\n\nCo-Authored-By: A <a@b.c>",
    });
  });
  test("headline only", () => {
    expect(splitMessage("fix: y\n")).toEqual({ headline: "fix: y", body: "" });
  });
});

describe("buildCommitInput", () => {
  test("base64 additions, deletions, message and expectedHeadOid", () => {
    const input = buildCommitInput({
      repo: "acme/widgets",
      branch: "feat/x",
      expectedHeadOid: SHA_A,
      message: "feat: x\n\nCo-Authored-By: A <a@b.c>\n",
      additions: [{ path: "a.txt", contents: Buffer.from("hi\n") }],
      deletions: ["b.txt"],
    });
    expect(input).toEqual({
      branch: { repositoryNameWithOwner: "acme/widgets", branchName: "feat/x" },
      message: {
        headline: "feat: x",
        body: "Co-Authored-By: A <a@b.c>",
      },
      fileChanges: {
        additions: [{ path: "a.txt", contents: "aGkK" }],
        deletions: [{ path: "b.txt" }],
      },
      expectedHeadOid: SHA_A,
    });
  });
  test("omits an empty body", () => {
    const input = buildCommitInput({
      repo: "a/b",
      branch: "x",
      expectedHeadOid: SHA_A,
      message: "fix: y\n",
      additions: [],
      deletions: [],
    });
    expect(input.message).toEqual({ headline: "fix: y" });
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
