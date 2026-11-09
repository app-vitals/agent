import { describe, expect, it } from "bun:test";
import {
  parseAgentImageMap,
  readAgentImageConfig,
  resolveImage,
} from "./agent-image-map.ts";

const fallback = { repository: "ghcr.io/x/agent", tag: "1.0.0" };
const json = JSON.stringify({
  reviewer: { repository: "ghcr.io/x/reviewer", tag: "2.0.0" },
});

describe("parseAgentImageMap", () => {
  it("returns undefined when unset, empty or blank", () => {
    expect(parseAgentImageMap(undefined)).toBeUndefined();
    expect(parseAgentImageMap("")).toBeUndefined();
    expect(parseAgentImageMap("  ")).toBeUndefined();
    expect(parseAgentImageMap("{}")).toBeUndefined();
  });

  it("parses a valid map", () => {
    expect(parseAgentImageMap(json)).toEqual({
      reviewer: { repository: "ghcr.io/x/reviewer", tag: "2.0.0" },
    });
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
    ["a non-object entry", '{"a":"img:1"}'],
    ["a null entry", '{"a":null}'],
    ["a missing tag", '{"a":{"repository":"r"}}'],
    ["an empty repository", '{"a":{"repository":"","tag":"t"}}'],
    ["a non-string tag", '{"a":{"repository":"r","tag":1}}'],
  ])("throws on %s", (_name, raw) => {
    expect(() => parseAgentImageMap(raw)).toThrow(/SHIPWRIGHT_AGENT_IMAGES/);
  });
});

describe("resolveImage", () => {
  it("uses the fallback when no map is set", () => {
    expect(resolveImage(fallback, undefined, "reviewer")).toEqual(fallback);
    expect(resolveImage(fallback, undefined)).toEqual(fallback);
  });

  it("uses the mapped entry for a mapped specialty", () => {
    const map = parseAgentImageMap(json);
    expect(resolveImage(fallback, map, "reviewer")).toEqual({
      repository: "ghcr.io/x/reviewer",
      tag: "2.0.0",
    });
  });

  it("falls back for an unmapped or absent specialty", () => {
    const map = parseAgentImageMap(json);
    expect(resolveImage(fallback, map, "other")).toEqual(fallback);
    expect(resolveImage(fallback, map, undefined)).toEqual(fallback);
    expect(resolveImage(fallback, map, "toString")).toEqual(fallback);
  });

  it("uses the default key for unmapped specialties", () => {
    const map = parseAgentImageMap(
      JSON.stringify({ default: { repository: "d", tag: "9" } }),
    );
    expect(resolveImage(fallback, map, "other")).toEqual({
      repository: "d",
      tag: "9",
    });
  });
});

describe("readAgentImageConfig (SAL-1.3)", () => {
  it("defaults to an empty repository and the latest tag", () => {
    expect(readAgentImageConfig({})).toEqual({
      fallback: { repository: "", tag: "latest" },
      images: undefined,
    });
  });

  it("reads the single image, tag and the per-specialty map", () => {
    const cfg = readAgentImageConfig({
      SHIPWRIGHT_AGENT_IMAGE: "ghcr.io/x/agent",
      SHIPWRIGHT_AGENT_IMAGE_TAG: "1.2.3",
      SHIPWRIGHT_AGENT_IMAGES: json,
    });
    expect(cfg.fallback).toEqual({
      repository: "ghcr.io/x/agent",
      tag: "1.2.3",
    });
    expect(resolveImage(cfg.fallback, cfg.images, "reviewer")).toEqual({
      repository: "ghcr.io/x/reviewer",
      tag: "2.0.0",
    });
  });

  it("throws on a malformed map", () => {
    expect(() =>
      readAgentImageConfig({ SHIPWRIGHT_AGENT_IMAGES: "{nope" }),
    ).toThrow(/SHIPWRIGHT_AGENT_IMAGES is malformed/);
  });
});
