import { describe, expect, test } from "bun:test";
import { parseByteRange } from "./http-range.ts";

describe("parseByteRange", () => {
  test("no header means no range", () => {
    expect(parseByteRange(undefined, 100)).toEqual({ kind: "none" });
    expect(parseByteRange(null, 100)).toEqual({ kind: "none" });
  });
  test("mid-file range", () => {
    expect(parseByteRange("bytes=10-19", 100)).toEqual({
      kind: "range",
      start: 10,
      end: 19,
    });
  });
  test("open-ended range", () => {
    expect(parseByteRange("bytes=90-", 100)).toEqual({
      kind: "range",
      start: 90,
      end: 99,
    });
  });
  test("suffix range", () => {
    expect(parseByteRange("bytes=-10", 100)).toEqual({
      kind: "range",
      start: 90,
      end: 99,
    });
  });
  test("suffix longer than file clamps to whole file", () => {
    expect(parseByteRange("bytes=-500", 100)).toEqual({
      kind: "range",
      start: 0,
      end: 99,
    });
  });
  test("end past EOF is clamped", () => {
    expect(parseByteRange("bytes=50-999", 100)).toEqual({
      kind: "range",
      start: 50,
      end: 99,
    });
  });
  test("start at or beyond size is unsatisfiable", () => {
    expect(parseByteRange("bytes=100-", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(parseByteRange("bytes=500-600", 100)).toEqual({
      kind: "unsatisfiable",
    });
  });
  test("zero-length suffix and empty file are unsatisfiable", () => {
    expect(parseByteRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });
  test("start > end is ignored (treated as no range)", () => {
    expect(parseByteRange("bytes=20-10", 100)).toEqual({ kind: "none" });
  });
  test("malformed, multi-range and non-bytes units are ignored", () => {
    expect(parseByteRange("bytes=abc", 100)).toEqual({ kind: "none" });
    expect(parseByteRange("bytes=0-1,5-6", 100)).toEqual({ kind: "none" });
    expect(parseByteRange("items=0-1", 100)).toEqual({ kind: "none" });
    expect(parseByteRange("bytes=-", 100)).toEqual({ kind: "none" });
  });
});
