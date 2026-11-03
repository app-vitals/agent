import { describe, expect, it } from "bun:test";
import {
  parseAgentPodLabels,
  validateAgentPodLabels,
} from "./agent-pod-labels.ts";

describe("agent pod label configuration", () => {
  it("leaves unconfigured labels absent", () => {
    expect(parseAgentPodLabels(undefined)).toBeUndefined();
    expect(parseAgentPodLabels("  ")).toBeUndefined();
    expect(parseAgentPodLabels("{}")).toEqual({});
  });
  it("accepts qualified keys, plain keys and Kubernetes label values", () => {
    expect(
      parseAgentPodLabels(
        '{"vgs.io/team":"team-infrastructure","app":"shipwright","empty":""}',
      ),
    ).toEqual({
      "vgs.io/team": "team-infrastructure",
      app: "shipwright",
      empty: "",
    });
  });
  for (const raw of [
    "null",
    "[]",
    "false",
    "1",
    "invalid",
    '{"app":1}',
    '{"app":null}',
  ]) {
    it(`rejects malformed config ${raw}`, () =>
      expect(() => parseAgentPodLabels(raw)).toThrow());
  }
  for (const key of [
    "",
    "/app",
    "UPPER.io/app",
    "bad..io/app",
    "a/b/c",
    "a".repeat(64),
    "app.kubernetes.io/name",
    "app.kubernetes.io/instance",
    "app.kubernetes.io/managed-by",
    "shipwright.dev/agent-id",
    "shipwright.dev/tenant",
  ]) {
    it(`rejects invalid or reserved key ${key}`, () =>
      expect(() => validateAgentPodLabels({ [key]: "x" })).toThrow());
  }
  for (const value of [
    "bad/value",
    "bad value",
    "-bad",
    "bad-",
    "x".repeat(64),
  ]) {
    it(`rejects invalid value ${value}`, () =>
      expect(() => validateAgentPodLabels({ app: value })).toThrow());
  }
});
