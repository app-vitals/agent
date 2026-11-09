import { describe, expect, it } from "bun:test";
import {
  AGENT_PLATFORM_PLUGIN,
  resolveDefaultPlugins,
} from "./default-plugins.ts";

describe("resolveDefaultPlugins", () => {
  it("returns the platform default when no extension plugins are given", () => {
    expect(resolveDefaultPlugins()).toEqual([AGENT_PLATFORM_PLUGIN]);
  });

  it("appends extension plugins after the platform default", () => {
    expect(resolveDefaultPlugins(["ext@market"])).toEqual([
      AGENT_PLATFORM_PLUGIN,
      "ext@market",
    ]);
  });

  it("dedupes an extension that also lists the platform plugin", () => {
    expect(resolveDefaultPlugins([AGENT_PLATFORM_PLUGIN, "x@y"])).toEqual([
      AGENT_PLATFORM_PLUGIN,
      "x@y",
    ]);
  });
});
