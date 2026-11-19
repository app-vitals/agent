import { describe, expect, it } from "bun:test";
import { parseOverrides } from "./member-id-backfill.ts";

describe("parseOverrides", () => {
  it("normalizes email keys", () => {
    expect(parseOverrides('{" Bob@X.com ":"m1"}').get("bob@x.com")).toBe("m1");
  });
  it("rejects non-object and non-string values", () => {
    expect(() => parseOverrides("[]")).toThrow();
    expect(() => parseOverrides('{"a@b.c":1}')).toThrow();
  });
});
