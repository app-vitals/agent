/**
 * admin/src/github-lookup-repositories.unit.test.ts
 * Cache-backed githubLookup: syncState derivation, the unconfigured cases and
 * the guarantee that no GitHub call is made.
 */

import { describe, expect, it } from "bun:test";
import { createGithubLookupService } from "./github-enterprise-api.ts";
import type { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import {
  type LookupSnapshotView,
  summarizeLookupSnapshots,
} from "./github-lookup-repositories.ts";

const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const snap = (o: Partial<LookupSnapshotView> = {}): LookupSnapshotView => ({
  completedAt: ago(10 * MIN),
  totalCount: 2,
  lastError: null,
  repos: [
    { fullName: "acme/a", archived: false },
    { fullName: "acme/b", archived: true },
  ],
  ...o,
});

describe("summarizeLookupSnapshots", () => {
  it("no snapshot yet: configured, empty, syncing", () => {
    expect(summarizeLookupSnapshots([], NOW)).toEqual({
      configured: true,
      repos: [],
      syncState: "syncing",
    });
  });

  it("complete and fresh: ready with fetchedAt and progress", () => {
    const r = summarizeLookupSnapshots([snap()], NOW);
    expect(r.syncState).toBe("ready");
    expect(r.fetchedAt).toEqual(ago(10 * MIN));
    expect(r.progress).toEqual({ reposSeen: 2, totalCount: 2 });
    expect(r.repos).toEqual([
      { fullName: "acme/a", archived: false },
      { fullName: "acme/b", archived: true },
    ]);
  });

  it("complete but older than the TTL: stale, repos still served", () => {
    const r = summarizeLookupSnapshots(
      [snap({ completedAt: ago(61 * MIN) })],
      NOW,
    );
    expect(r.syncState).toBe("stale");
    expect(r.repos).toHaveLength(2);
  });

  it("honours a custom TTL", () => {
    const r = summarizeLookupSnapshots([snap()], NOW, 5 * MIN);
    expect(r.syncState).toBe("stale");
  });

  it("in-progress crawl: partial repos, syncing, progress, no fetchedAt", () => {
    const r = summarizeLookupSnapshots(
      [
        snap({
          completedAt: null,
          totalCount: 10,
          repos: [{ fullName: "acme/a", archived: false }],
        }),
      ],
      NOW,
    );
    expect(r.syncState).toBe("syncing");
    expect(r.repos).toEqual([{ fullName: "acme/a", archived: false }]);
    expect(r.progress).toEqual({ reposSeen: 1, totalCount: 10 });
    expect(r.fetchedAt).toBeUndefined();
  });

  it("incomplete crawl with an error: failed", () => {
    const r = summarizeLookupSnapshots(
      [snap({ completedAt: null, lastError: "boom" })],
      NOW,
    );
    expect(r.syncState).toBe("failed");
  });

  it("omits totalCount while any org has not reported one", () => {
    const r = summarizeLookupSnapshots(
      [snap(), snap({ completedAt: null, totalCount: null, repos: [] })],
      NOW,
    );
    expect(r.progress).toEqual({ reposSeen: 2 });
  });

  it("merges orgs: syncing beats stale, failed beats syncing, dedupes repos", () => {
    const orgA = snap({ completedAt: ago(90 * MIN) });
    const orgB = snap({
      completedAt: null,
      repos: [{ fullName: "acme/a", archived: false }],
    });
    const mixed = summarizeLookupSnapshots([orgA, orgB], NOW);
    expect(mixed.syncState).toBe("syncing");
    expect(mixed.repos.map((r) => r.fullName).sort()).toEqual([
      "acme/a",
      "acme/b",
    ]);
    const failed = summarizeLookupSnapshots(
      [orgA, { ...orgB, lastError: "x" }],
      NOW,
    );
    expect(failed.syncState).toBe("failed");
  });

  it("fetchedAt is the oldest completion across orgs", () => {
    const r = summarizeLookupSnapshots(
      [
        snap({ completedAt: ago(5 * MIN) }),
        snap({ completedAt: ago(30 * MIN) }),
      ],
      NOW,
    );
    expect(r.fetchedAt).toEqual(ago(30 * MIN));
  });
});

describe("createGithubLookupService", () => {
  type Row = { appId: string; enterpriseSlug: string | null };
  function apps(rows: Record<string, Row | undefined>, withKey = true) {
    return {
      get: async (role: string) => rows[role] ?? null,
      getPrivateKey: async (role: string) =>
        rows[role] && withKey ? "pem" : null,
    } as unknown as GitHubEnterpriseAppService;
  }
  const lookupRow = { appId: "555", enterpriseSlug: null };

  function build(
    rows: Record<string, Row | undefined>,
    snapshots: LookupSnapshotView[] = [],
    withKey = true,
  ) {
    const calls: unknown[][] = [];
    const svc = createGithubLookupService({
      appService: apps(rows, withKey),
      now: () => NOW,
      cache: {
        listLookupSnapshots: async (...args: unknown[]) => {
          calls.push(args);
          return snapshots;
        },
      },
    });
    return { svc, calls };
  }

  it("unconfigured when no lookup App: configured:false, cache untouched", async () => {
    const { svc, calls } = build({});
    expect(await svc.listRepositories("acct")).toEqual({
      configured: false,
      repos: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("unconfigured when the lookup App has no key", async () => {
    const { svc } = build({ lookup: lookupRow }, [], false);
    expect((await svc.listRepositories()).configured).toBe(false);
  });

  it("unconfigured when an installer with a slug has no key", async () => {
    const rows = {
      lookup: lookupRow,
      installer: { appId: "1", enterpriseSlug: "ent" },
    };
    const svc = createGithubLookupService({
      appService: {
        get: async (role: string) => (rows as Record<string, Row>)[role],
        getPrivateKey: async (role: string) =>
          role === "lookup" ? "pem" : null,
      } as unknown as GitHubEnterpriseAppService,
      cache: { listLookupSnapshots: async () => [] },
    });
    expect((await svc.listRepositories()).configured).toBe(false);
  });

  it("cold start: configured, empty, syncing", async () => {
    const { svc } = build({ lookup: lookupRow });
    expect(await svc.listRepositories("acct")).toEqual({
      configured: true,
      repos: [],
      syncState: "syncing",
    });
  });

  it("queries the account and deployment-wide scopes by lookup App id", async () => {
    const { svc, calls } = build({ lookup: lookupRow }, [snap()]);
    const r = await svc.listRepositories("acct");
    expect(r.syncState).toBe("ready");
    expect(calls[0]).toEqual([["acct", ""], "555"]);
    await svc.listRepositories();
    expect(calls[1]).toEqual([[""], "555"]);
  });
});
