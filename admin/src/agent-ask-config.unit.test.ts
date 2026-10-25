/**
 * admin/src/agent-ask-config.unit.test.ts
 * Pure parser tests for the agent-ask flag and from>to allowlist (COS-31.1).
 */

import { describe, expect, it } from "bun:test";
import { isAskAllowed, parseAgentAskConfig } from "./agent-ask-config.ts";

describe("parseAgentAskConfig — flag", () => {
  it('is on only for the literal "enabled"', () => {
    expect(
      parseAgentAskConfig({ SHIPWRIGHT_AGENT_ASK_ENABLED: "enabled" }).enabled,
    ).toBe(true);
  });

  it('"true", "" and absent are off', () => {
    for (const value of ["true", "", "Enabled", " enabled", undefined]) {
      expect(
        parseAgentAskConfig({ SHIPWRIGHT_AGENT_ASK_ENABLED: value }).enabled,
      ).toBe(false);
    }
    expect(parseAgentAskConfig({}).enabled).toBe(false);
  });
});

describe("parseAgentAskConfig — allowlist", () => {
  it("parses comma-separated from>to pairs, trimming whitespace", () => {
    const config = parseAgentAskConfig({
      SHIPWRIGHT_AGENT_ASK_ALLOWLIST: " a > b ,c>d,, ",
    });
    expect([...config.allowlist].sort()).toEqual(["a>b", "c>d"]);
    expect(isAskAllowed(config, "a", "b")).toBe(true);
    expect(isAskAllowed(config, "c", "d")).toBe(true);
  });

  it("pairs are directional", () => {
    const config = parseAgentAskConfig({
      SHIPWRIGHT_AGENT_ASK_ALLOWLIST: "a>b",
    });
    expect(isAskAllowed(config, "b", "a")).toBe(false);
    expect(isAskAllowed(config, "a", "c")).toBe(false);
  });

  it("an empty or absent allowlist denies every pair", () => {
    for (const value of ["", "  ", " , ", undefined]) {
      const config = parseAgentAskConfig({
        SHIPWRIGHT_AGENT_ASK_ENABLED: "enabled",
        SHIPWRIGHT_AGENT_ASK_ALLOWLIST: value,
      });
      expect(config.allowlist.size).toBe(0);
      expect(isAskAllowed(config, "a", "b")).toBe(false);
    }
  });

  it("a malformed pair throws naming it", () => {
    for (const bad of ["ab", "a>", ">b", "a>b>c", "a b>c"]) {
      expect(() =>
        parseAgentAskConfig({
          SHIPWRIGHT_AGENT_ASK_ALLOWLIST: `x>y,${bad}`,
        }),
      ).toThrow(JSON.stringify(bad));
    }
  });

  it("names every malformed pair in one error", () => {
    expect(() =>
      parseAgentAskConfig({ SHIPWRIGHT_AGENT_ASK_ALLOWLIST: "one,a>b,two>" }),
    ).toThrow(/"one".*"two>"/);
  });
});
