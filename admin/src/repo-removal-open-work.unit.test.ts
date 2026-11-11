import { describe, expect, it } from "bun:test";
import type { OpenWorkPort } from "./reconcile-open-work.ts";
import {
  blockRepoRemovalWork,
  previewRepoRemovalWork,
  repoRemovedFromAgentBlockReason,
} from "./repo-removal-open-work.ts";

const ITEMS = [{ id: "T-1", repo: "a/one", title: "t" }];

function port(over: Partial<OpenWorkPort> = {}) {
  const calls: unknown[][] = [];
  const p: OpenWorkPort = {
    listOpenWork: async (...a) => {
      calls.push(["list", ...a]);
      return ITEMS;
    },
    blockOpenWork: async (...a) => {
      calls.push(["block", ...a]);
    },
    ...over,
  };
  return { p, calls };
}

describe("previewRepoRemovalWork", () => {
  it("lists open work from the port", async () => {
    const { p } = port();
    expect(await previewRepoRemovalWork(p, "ag", ["a/one"])).toEqual({
      openWork: ITEMS,
      warnings: [],
    });
  });
  it("is empty without a port", async () => {
    expect(await previewRepoRemovalWork(undefined, "ag", ["a/one"])).toEqual({
      openWork: [],
      warnings: [],
    });
  });
  it("turns a port failure into a warning", async () => {
    const { p } = port({
      listOpenWork: async () => {
        throw new Error("down");
      },
    });
    const r = await previewRepoRemovalWork(p, "ag", ["a/one"]);
    expect(r.openWork).toEqual([]);
    expect(r.warnings[0]).toContain("down");
  });
  it("never blocks", async () => {
    const { p, calls } = port();
    await previewRepoRemovalWork(p, "ag", ["a/one"]);
    expect(calls.some((c) => c[0] === "block")).toBe(false);
  });
});

describe("blockRepoRemovalWork", () => {
  it("blocks each repo with a reason naming it", async () => {
    const { p, calls } = port();
    expect(await blockRepoRemovalWork(p, "ag", ["a/one", "b/two"])).toEqual([]);
    expect(calls).toEqual([
      ["block", "ag", ["a/one"], repoRemovedFromAgentBlockReason("a/one")],
      ["block", "ag", ["b/two"], repoRemovedFromAgentBlockReason("b/two")],
    ]);
    expect(repoRemovedFromAgentBlockReason("a/one")).toContain("a/one");
  });
  it("does nothing without a port", async () => {
    expect(await blockRepoRemovalWork(undefined, "ag", ["a/one"])).toEqual([]);
  });
  it("warns on port failure and continues with the next repo", async () => {
    let n = 0;
    const { p } = port({
      blockOpenWork: async () => {
        if (n++ === 0) throw new Error("boom");
      },
    });
    const w = await blockRepoRemovalWork(p, "ag", ["a/one", "b/two"]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("a/one");
  });
});
