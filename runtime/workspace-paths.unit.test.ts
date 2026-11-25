/**
 * Unit tests for agent/src/runtime/workspace-paths.ts — env-driven, no module mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveWorkspacePath, splitOrgRepo } from "./workspace-paths.ts";

describe("resolveWorkspacePath", () => {
  let savedWorkspacePath: string | undefined;
  let savedAgentHome: string | undefined;

  beforeEach(() => {
    savedWorkspacePath = process.env.WORKSPACE_PATH;
    savedAgentHome = process.env.AGENT_HOME;
    delete process.env.WORKSPACE_PATH;
    delete process.env.AGENT_HOME;
  });

  afterEach(() => {
    if (savedWorkspacePath === undefined) delete process.env.WORKSPACE_PATH;
    else process.env.WORKSPACE_PATH = savedWorkspacePath;
    if (savedAgentHome === undefined) delete process.env.AGENT_HOME;
    else process.env.AGENT_HOME = savedAgentHome;
  });

  it("prefers WORKSPACE_PATH over AGENT_HOME", () => {
    process.env.WORKSPACE_PATH = "/explicit/ws";
    process.env.AGENT_HOME = "/home/agent";
    expect(resolveWorkspacePath()).toBe("/explicit/ws");
  });

  it("trims whitespace from WORKSPACE_PATH", () => {
    process.env.WORKSPACE_PATH = "  /explicit/ws \n";
    expect(resolveWorkspacePath()).toBe("/explicit/ws");
  });

  it("falls through to AGENT_HOME/workspace when WORKSPACE_PATH is whitespace-only", () => {
    process.env.WORKSPACE_PATH = "   ";
    process.env.AGENT_HOME = "/home/agent";
    expect(resolveWorkspacePath()).toBe("/home/agent/workspace");
  });

  it("falls through to AGENT_HOME/workspace when WORKSPACE_PATH is empty", () => {
    process.env.WORKSPACE_PATH = "";
    process.env.AGENT_HOME = "/home/agent";
    expect(resolveWorkspacePath()).toBe("/home/agent/workspace");
  });

  it("uses AGENT_HOME/workspace when WORKSPACE_PATH is unset", () => {
    process.env.AGENT_HOME = "/home/agent";
    expect(resolveWorkspacePath()).toBe("/home/agent/workspace");
  });

  it("trims whitespace from AGENT_HOME", () => {
    process.env.AGENT_HOME = "  /home/agent\t";
    expect(resolveWorkspacePath()).toBe("/home/agent/workspace");
  });

  it("throws when neither variable is set", () => {
    expect(() => resolveWorkspacePath()).toThrow(/AGENT_HOME is not set/);
  });

  it("throws when both variables are blank", () => {
    process.env.WORKSPACE_PATH = "  ";
    process.env.AGENT_HOME = " ";
    expect(() => resolveWorkspacePath()).toThrow(/AGENT_HOME is not set/);
  });
});

describe("splitOrgRepo", () => {
  it("splits org/repo into [org, repo]", () => {
    expect(splitOrgRepo("acme/widgets")).toEqual(["acme", "widgets"]);
  });

  it("defaults org to app-vitals for a bare repo name", () => {
    expect(splitOrgRepo("shipwright")).toEqual(["app-vitals", "shipwright"]);
  });

  it("drops segments beyond the second when given extra slashes", () => {
    expect(splitOrgRepo("a/b/c")).toEqual(["a", "b"]);
  });
});
