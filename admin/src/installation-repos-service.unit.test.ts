/**
 * admin/src/installation-repos-service.unit.test.ts
 * IRM-1.2: the user-can-push hint logic and the list service, with
 * in-memory ports.
 */

import { describe, expect, it } from "bun:test";
import {
  InstallationReposService,
  NO_INSTALLATION_REASON,
  type InstallationReposPort,
  userPushHints,
} from "./installation-repos-service.ts";
import type {
  OrgAccessResult,
  UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

const orgResult = (over: Partial<OrgAccessResult> = {}): OrgAccessResult => ({
  org: "acme",
  status: "ok",
  unresolved: 0,
  repos: [
    { fullName: "acme/push", level: "write", canPush: true },
    { fullName: "acme/readonly", level: "read", canPush: false },
  ],
  ...over,
});

const accessOf = (
  orgs: OrgAccessResult[],
  over: Partial<UserRepoAccessResult> = {},
): UserRepoAccessResult => ({
  username: "dev",
  outcome: "ok",
  userVerified: true,
  orgs,
  unresolved: 0,
  complete: true,
  checkedAt: "2026-11-11T00:00:00.000Z",
  ...over,
});

describe("userPushHints", () => {
  const repos = ["acme/push", "acme/readonly", "acme/unlisted"];

  it("reports true/false for listed repos and omits unlisted ones", () => {
    expect(userPushHints(accessOf([orgResult()]), "acme", repos)).toEqual([
      { fullName: "acme/push", userCanPush: true },
      { fullName: "acme/readonly", userCanPush: false },
      { fullName: "acme/unlisted" },
    ]);
  });

  it("matches org and repo names case-insensitively", () => {
    expect(
      userPushHints(accessOf([orgResult()]), "ACME", ["Acme/Push"]),
    ).toEqual([{ fullName: "Acme/Push", userCanPush: true }]);
  });

  it("omits every hint when there is no access result", () => {
    expect(userPushHints(undefined, "acme", repos).every(noHint)).toBe(true);
  });

  it("omits every hint when the org's result is partial, errored, unresolved or missing", () => {
    for (const o of [
      orgResult({ status: "partial" }),
      orgResult({ status: "error" }),
      orgResult({ status: "rate_limited" }),
      orgResult({ status: "lookup_app_not_installed" }),
      orgResult({ unresolved: 2 }),
    ]) {
      expect(userPushHints(accessOf([o]), "acme", repos).every(noHint)).toBe(
        true,
      );
    }
    expect(
      userPushHints(accessOf([orgResult()]), "other", repos).every(noHint),
    ).toBe(true);
  });

  it("omits hints for an unverified or missing user", () => {
    expect(
      userPushHints(
        accessOf([orgResult()], { userVerified: false }),
        "acme",
        repos,
      ).every(noHint),
    ).toBe(true);
    expect(
      userPushHints(
        accessOf([orgResult()], { outcome: "user_not_found" }),
        "acme",
        repos,
      ).every(noHint),
    ).toBe(true);
  });
});

function noHint(r: { userCanPush?: boolean }): boolean {
  return r.userCanPush === undefined;
}

function build(
  opts: {
    agent?: { githubUsername: string | null; appId?: number } | null;
    noInstallation?: boolean;
    access?: () => Promise<
      | { status: "unconfigured" }
      | { status: "ok"; access: UserRepoAccessResult }
    >;
  } = {},
) {
  const installation: InstallationReposPort = {
    listInstalled: async () =>
      opts.noInstallation
        ? { status: "none" }
        : {
            status: "found",
            orgs: [{ org: "acme", repos: ["acme/push", "acme/unlisted"] }],
          },
    listRepos: async () => ({}),
    addRepos: async () => {},
    removeRepos: async () => {},
  };
  const agent =
    opts.agent === undefined
      ? { id: "a1", repos: [], githubUsername: "dev", appId: 42 }
      : opts.agent && { id: "a1", repos: [], ...opts.agent };
  const svc = new InstallationReposService({
    agents: { get: async () => agent },
    access:
      opts.access ??
      (async () => ({ status: "ok", access: accessOf([orgResult()]) })),
    installation,
  });
  return { svc };
}

describe("InstallationReposService.list", () => {
  it("returns repos per org with hints for a bound user", async () => {
    const { svc } = build();
    expect(await svc.list("a1")).toEqual({
      status: "ok",
      appId: 42,
      orgs: [
        {
          org: "acme",
          repos: [
            { fullName: "acme/push", userCanPush: true },
            { fullName: "acme/unlisted" },
          ],
        },
      ],
    });
  });

  it("omits hints for an unbound agent without calling access", async () => {
    let called = false;
    const { svc } = build({
      agent: { githubUsername: null, appId: 42 },
      access: async () => {
        called = true;
        return { status: "unconfigured" };
      },
    });
    const r = await svc.list("a1");
    expect(called).toBe(false);
    expect(r.status === "ok" && r.orgs[0]?.repos.every(noHint)).toBe(true);
  });

  it("omits hints when access is unconfigured or the lookup throws", async () => {
    for (const access of [
      async () => ({ status: "unconfigured" as const }),
      async () => {
        throw new Error("502");
      },
    ]) {
      const r = await build({ access }).svc.list("a1");
      expect(r.status === "ok" && r.orgs[0]?.repos.every(noHint)).toBe(true);
    }
  });

  it("is skipped with a reason when the App matches no installation", async () => {
    const r = await build({ noInstallation: true }).svc.list("a1");
    expect(r).toEqual({
      status: "skipped",
      appId: 42,
      reason: NO_INSTALLATION_REASON,
    });
  });

  it("reports unknown agent and a missing GH_APP_ID distinctly", async () => {
    expect(await build({ agent: null }).svc.list("x")).toEqual({
      status: "agent_not_found",
    });
    const r = await build({ agent: { githubUsername: "dev" } }).svc.list("a1");
    expect(r.status).toBe("no_app_id");
  });
});
