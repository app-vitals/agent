/**
 * admin/src/installation-repos-service.unit.test.ts
 * IRM-1.2: the user-can-push hint logic and the list service, with
 * in-memory ports.
 */

import { describe, expect, it } from "bun:test";
import {
  type CachedAccessRow,
  type InstallationCachePort,
  InstallationReposService,
  type InstallationSnapshotRow,
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

const row = (
  repo: string,
  status: string,
  canPush = false,
): CachedAccessRow => ({ repo, status, canPush });

describe("userPushHints from cached access rows", () => {
  const repos = ["acme/push", "acme/readonly"];

  it("reports true/false per repo when every repo has an ok row", () => {
    const out = userPushHints(
      { cachedRows: [row("push", "ok", true), row("ReadOnly", "ok", false)] },
      "acme",
      repos,
    );
    expect(out).toEqual([
      { fullName: "acme/push", userCanPush: true },
      { fullName: "acme/readonly", userCanPush: false },
    ]);
  });

  it("omits every hint when any pair is missing, errored or terminal (never false)", () => {
    for (const second of [
      undefined,
      row("readonly", "error", false),
      row("readonly", "terminal", false),
    ]) {
      const rows = [row("push", "ok", true), ...(second ? [second] : [])];
      expect(
        userPushHints({ cachedRows: rows }, "acme", repos).every(noHint),
      ).toBe(true);
    }
  });

  it("omits hints with no rows at all", () => {
    expect(userPushHints({ cachedRows: [] }, "acme", repos).every(noHint)).toBe(
      true,
    );
  });
});

const T0 = new Date("2026-11-20T10:00:00Z");
const snap = (
  over: Partial<InstallationSnapshotRow> = {},
): InstallationSnapshotRow => ({
  org: "acme",
  completedAt: T0,
  totalCount: 2,
  lastError: null,
  rateLimitResetAt: null,
  repos: [{ fullName: "acme/push" }, { fullName: "acme/readonly" }],
  ...over,
});

function build(
  opts: {
    agent?: { githubUsername: string | null; appId?: number } | null;
    snapshots?: InstallationSnapshotRow[];
    rows?: CachedAccessRow[];
  } = {},
) {
  const calls: string[] = [];
  const cache: InstallationCachePort = {
    listAgentSnapshots: async (accountId, appRef) => {
      calls.push(`snapshots:${accountId}:${appRef}`);
      return opts.snapshots ?? [snap()];
    },
    getAccessRows: async (q) => {
      calls.push(`rows:${q.accountId}:${q.org}:${q.username}`);
      return opts.rows ?? [row("push", "ok", true), row("readonly", "ok")];
    },
  };
  const agent =
    opts.agent === undefined
      ? { id: "a1", repos: [], githubUsername: "dev", appId: 42 }
      : opts.agent && { id: "a1", repos: [], ...opts.agent };
  const boom = () => {
    throw new Error("GitHub must not be called");
  };
  const svc = new InstallationReposService({
    agents: { get: async () => agent },
    access: boom,
    installation: {
      listInstalled: boom,
      listRepos: boom,
      addRepos: boom,
      removeRepos: boom,
    },
    cache,
  });
  return { svc, calls };
}

describe("InstallationReposService.list (cache read)", () => {
  it("returns cached repos with hints and sync detail for a complete snapshot", async () => {
    const { svc, calls } = build();
    const r = await svc.list("a1");
    expect(r).toMatchObject({
      status: "ok",
      appId: 42,
      complete: true,
      syncedAt: T0.toISOString(),
      reposSeen: 2,
      totalCount: 2,
      orgs: [
        {
          org: "acme",
          complete: true,
          syncedAt: T0.toISOString(),
          reposSeen: 2,
          totalCount: 2,
          repos: [
            { fullName: "acme/push", userCanPush: true },
            { fullName: "acme/readonly", userCanPush: false },
          ],
        },
      ],
    });
    expect(calls[0]).toBe("snapshots:deployment:42");
  });

  it("omits hints when an access pair is errored or missing", async () => {
    const r = await build({
      rows: [row("push", "ok", true), row("readonly", "error")],
    }).svc.list("a1");
    expect(r.status === "ok" && r.orgs[0]?.repos.every(noHint)).toBe(true);
  });

  it("omits hints and skips the access read for an unbound agent", async () => {
    const { svc, calls } = build({
      agent: { githubUsername: null, appId: 42 },
    });
    const r = await svc.list("a1");
    expect(calls.some((c) => c.startsWith("rows:"))).toBe(false);
    expect(r.status === "ok" && r.orgs[0]?.repos.every(noHint)).toBe(true);
  });

  it("an incomplete snapshot is not complete and carries error and rate-limit detail", async () => {
    const reset = new Date("2026-11-20T11:00:00Z");
    const r = await build({
      snapshots: [
        snap({
          completedAt: null,
          totalCount: 5,
          lastError: "boom",
          rateLimitResetAt: reset,
          repos: [{ fullName: "acme/push" }],
        }),
      ],
    }).svc.list("a1");
    expect(r).toMatchObject({
      status: "ok",
      complete: false,
      reposSeen: 1,
      totalCount: 5,
      lastError: "boom",
      rateLimitResetAt: reset.toISOString(),
    });
    expect(r.status === "ok" && r.syncedAt).toBeUndefined();
    expect(r.status === "ok" && r.orgs[0]?.repos.every(noHint)).toBe(true);
  });

  it("no snapshots yet: ok, empty, not complete", async () => {
    const r = await build({ snapshots: [] }).svc.list("a1");
    expect(r).toMatchObject({ status: "ok", orgs: [], complete: false });
  });

  it("uses the agent's account for the cache scope", async () => {
    const calls: string[] = [];
    const svc = new InstallationReposService({
      agents: {
        get: async () => ({
          id: "a1",
          repos: [],
          githubUsername: null,
          appId: 7,
          accountId: "acct-1",
        }),
      },
      access: async () => ({ status: "unconfigured" }),
      installation: {} as never,
      cache: {
        listAgentSnapshots: async (a, r) => {
          calls.push(`${a}:${r}`);
          return [];
        },
        getAccessRows: async () => [],
      },
    });
    await svc.list("a1");
    expect(calls).toEqual(["acct-1:7"]);
  });

  it("reports unknown agent and a missing GH_APP_ID distinctly", async () => {
    expect(await build({ agent: null }).svc.list("x")).toEqual({
      status: "agent_not_found",
    });
    const r = await build({ agent: { githubUsername: "dev" } }).svc.list("a1");
    expect(r.status).toBe("no_app_id");
  });
});
