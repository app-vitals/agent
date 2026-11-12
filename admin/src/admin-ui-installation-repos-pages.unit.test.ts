/**
 * admin/src/admin-ui-installation-repos-pages.unit.test.ts
 * Unit tests for the pure IRM-1.4 helpers and escaping.
 */

import { describe, expect, it } from "bun:test";
import {
  actuallyBlockedWork,
  renderOpenWorkByRepo,
  uncoveredRepos,
} from "./admin-ui-installation-repos-pages.ts";

describe("uncoveredRepos", () => {
  it("returns agent repos missing from the installation, case-insensitively", () => {
    expect(
      uncoveredRepos(["Acme/Api", "acme/web", "x/y"], ["acme/api", "acme/web"]),
    ).toEqual(["x/y"]);
  });
  it("returns nothing when all are covered", () => {
    expect(uncoveredRepos(["a/b"], ["a/b"])).toEqual([]);
  });
});

describe("actuallyBlockedWork", () => {
  const seen = [
    { id: "a/b#1", repo: "a/b" },
    { id: "t1", repo: "c/d" },
    { id: "t2", repo: "e/f" },
  ];
  it("keeps only work on removed repos whose blocking did not warn", () => {
    expect(
      actuallyBlockedWork(
        seen,
        ["a/b", "c/d"],
        ["open work for c/d was not blocked: boom"],
      ).map((w) => w.id),
    ).toEqual(["a/b#1"]);
  });
});

describe("renderOpenWorkByRepo", () => {
  it("groups per repo, links PR ids and escapes titles and ids", () => {
    const html = renderOpenWorkByRepo(
      [
        { id: "a/b#1", repo: "a/b", title: "<script>" },
        { id: "<id>", repo: "a/b" },
      ],
      "H",
      "none",
    );
    expect(html.match(/font-weight:600">a\/b</g)?.length).toBe(1);
    expect(html).toContain('href="https://github.com/a/b/pull/1"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;id&gt;");
    expect(html).not.toContain("<script>");
  });
});
