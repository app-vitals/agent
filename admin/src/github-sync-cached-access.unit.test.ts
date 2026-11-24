import { describe, expect, it } from "bun:test";
import { buildCachedAccess } from "./github-sync-cached-access.ts";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const HOUR = 3_600_000;
const build = (o: Parameters<typeof buildCachedAccess>[0]["orgs"][number]) =>
  buildCachedAccess({
    username: "octo",
    now: NOW,
    maxAgeMs: 24 * HOUR,
    orgs: [o],
  }).orgs[0];

const row = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  status: "ok",
  canPush: true,
  checkedAt: new Date(NOW.getTime() - HOUR),
  ...over,
});

describe("buildCachedAccess skip detail", () => {
  it("reports a missing lookup snapshot", () => {
    const r = build({
      org: "acme",
      crawls: [],
      crawlMissing: true,
      lookupSnapshotFound: false,
      repos: [],
      rows: [],
    });
    expect(r?.reason).toBe("access data is incomplete");
    expect(r?.detail).toMatchObject({
      lookupSnapshotFound: false,
      totalRepos: 0,
      reposWithOkAccess: 0,
      reposMissingAnswer: 0,
    });
  });

  it("reports an incomplete crawl with its lastError and rateLimitResetAt", () => {
    const reset = new Date("2026-11-20T13:00:00.000Z");
    const r = build({
      org: "acme",
      crawls: [
        { completedAt: null, lastError: "boom", rateLimitResetAt: reset },
      ],
      lookupSnapshotFound: true,
      repos: ["acme/a"],
      rows: [row("a")],
    });
    expect(r?.detail?.lookupSnapshotFound).toBe(true);
    expect(r?.detail?.crawls).toEqual([
      {
        completedAt: null,
        lastError: "boom",
        rateLimitResetAt: reset.toISOString(),
      },
    ]);
  });

  it("counts repos without an ok row, error and terminal rows", () => {
    const r = build({
      org: "acme",
      crawls: [{ completedAt: NOW }],
      repos: ["acme/a", "acme/b", "acme/c", "acme/d"],
      rows: [
        row("a"),
        row("b", { status: "error", attempts: 3, lastError: "rate limited" }),
        row("c", { status: "terminal", attempts: 5, lastError: "gone" }),
      ],
    });
    expect(r?.reason).toBe("access data is incomplete");
    expect(r?.detail).toMatchObject({
      totalRepos: 4,
      reposWithOkAccess: 1,
      reposMissingAnswer: 3,
      errorRows: 1,
      terminalRows: 1,
      maxAttempts: 5,
      rowErrors: ["rate limited", "gone"],
    });
  });

  it("reports the oldest-checked time for stale data", () => {
    const old = new Date(NOW.getTime() - 48 * HOUR);
    const r = build({
      org: "acme",
      crawls: [{ completedAt: NOW }],
      repos: ["acme/a"],
      rows: [row("a", { checkedAt: old })],
    });
    expect(r?.reason).toBe(
      `access data is stale (checked ${old.toISOString()})`,
    );
    expect(r?.detail).toMatchObject({
      oldestCheckedAt: old.toISOString(),
      totalRepos: 1,
      reposWithOkAccess: 1,
      reposMissingAnswer: 0,
    });
  });

  it("has no detail for a usable org", () => {
    const r = build({
      org: "acme",
      crawls: [{ completedAt: NOW }],
      repos: ["acme/a"],
      rows: [row("a")],
    });
    expect(r?.status).toBe("ok");
    expect(r?.detail).toBeUndefined();
  });
});
