/**
 * admin/src/agent-marketplaces.unit.test.ts
 * Unit tests for marketplace input validation (source, name, ref).
 */

import { describe, expect, it } from "bun:test";
import {
  validateMarketplaceName,
  validateMarketplaceRef,
  validateMarketplaceSource,
} from "./agent-marketplaces.ts";
import { UnprocessableEntityError } from "./errors.ts";

describe("validateMarketplaceSource", () => {
  it.each([
    "app-vitals/shipwright",
    "owner/repo.name",
    "Org_1/repo-2",
    "https://github.com/app-vitals/shipwright.git",
    "https://gitlab.example.com/group/sub/repo",
  ])("accepts %s", (source) => {
    expect(() => validateMarketplaceSource(source)).not.toThrow();
  });

  it.each([
    "",
    "   ",
    "repo",
    "owner/",
    "/repo",
    "owner/repo/extra",
    "owner/re po",
    "http://github.com/o/r",
    "git@github.com:o/r.git",
    "ssh://git@github.com/o/r",
    "file:///etc/passwd",
    "../etc",
    "./local/path",
    "-owner/repo",
    "https://",
    "https://user:pass@github.com/o/r",
    "https://github.com/o/r with space",
    "https://-evil.com/x",
  ])("rejects %p with a 422", (source) => {
    expect(() => validateMarketplaceSource(source)).toThrow(
      UnprocessableEntityError,
    );
  });
});

describe("validateMarketplaceName", () => {
  it("accepts simple names", () => {
    expect(() => validateMarketplaceName("shipwright")).not.toThrow();
    expect(() => validateMarketplaceName("my.market_place-2")).not.toThrow();
  });
  it.each(["", "a b", "a@b", "a/b", "-x"])("rejects %p", (name) => {
    expect(() => validateMarketplaceName(name)).toThrow(
      UnprocessableEntityError,
    );
  });
});

describe("validateMarketplaceRef", () => {
  it("accepts branches, tags, shas and absent refs", () => {
    for (const ref of [undefined, null, "main", "v1.2.3", "feat/x", "abc123"]) {
      expect(() => validateMarketplaceRef(ref)).not.toThrow();
    }
  });
  it.each(["", "-x", "a b", "a..b", "x;rm"])("rejects %p", (ref) => {
    expect(() => validateMarketplaceRef(ref)).toThrow(UnprocessableEntityError);
  });
});
