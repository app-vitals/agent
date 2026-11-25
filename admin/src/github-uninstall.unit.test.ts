/**
 * admin/src/github-uninstall.unit.test.ts
 * Unit tests for the org-uninstall plan and installation matching (GIS-1.5).
 */

import { describe, expect, it } from "bun:test";
import {
  findAgentInstallation,
  GITHUB_UNINSTALL_AUDIT_PLAN_HASH,
  planOrgUninstall,
  uninstallBlockReason,
} from "./github-uninstall.ts";

const inst = (
  id: number,
  extra: Partial<{ appId: number; appSlug: string; clientId: string }> = {},
) => ({
  id,
  appSlug: extra.appSlug ?? "other",
  accountLogin: "o",
  repositorySelection: "all" as const,
  ...(extra.appId === undefined ? {} : { appId: extra.appId }),
  ...(extra.clientId === undefined ? {} : { clientId: extra.clientId }),
});

describe("findAgentInstallation", () => {
  const all = [
    inst(1),
    inst(2, { appSlug: "My-App" }),
    inst(3, { clientId: "Iv1.x" }),
    inst(4, { appId: 99 }),
  ];
  it("matches by client id, slug (case-insensitive) and app id", () => {
    expect(findAgentInstallation(all, { clientId: "Iv1.x" })?.id).toBe(3);
    expect(findAgentInstallation(all, { slug: "my-app" })?.id).toBe(2);
    expect(findAgentInstallation(all, { appId: 99 })?.id).toBe(4);
  });
  it("prefers client id over slug", () => {
    expect(
      findAgentInstallation(all, { clientId: "Iv1.x", slug: "my-app" })?.id,
    ).toBe(3);
  });
  it("returns undefined when nothing matches or no identity is given", () => {
    expect(findAgentInstallation(all, { slug: "nope" })).toBeUndefined();
    expect(findAgentInstallation(all, {})).toBeUndefined();
  });
});

describe("planOrgUninstall", () => {
  it("selects only the agent repos in the org, case-insensitively, sorted", () => {
    const plan = planOrgUninstall({
      org: "Acme",
      agentRepos: ["acme/b", "other/x", "ACME/a", "acme-two/c"],
    });
    expect(plan.repos).toEqual(["ACME/a", "acme/b"]);
  });
  it("is empty when the agent has no repos in the org", () => {
    expect(
      planOrgUninstall({ org: "acme", agentRepos: ["o/x"] }).repos,
    ).toEqual([]);
  });
  it("needs confirmation only above the removal cap", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => `acme/r${i}`);
    expect(
      planOrgUninstall({ org: "acme", agentRepos: mk(10) }).needsConfirm,
    ).toBe(false);
    expect(
      planOrgUninstall({ org: "acme", agentRepos: mk(11) }).needsConfirm,
    ).toBe(true);
  });
});

describe("labels", () => {
  it("exposes the audit label and block reason", () => {
    expect(GITHUB_UNINSTALL_AUDIT_PLAN_HASH).toBe("uninstall:org");
    expect(uninstallBlockReason("acme/a")).toContain("acme/a");
  });
});
