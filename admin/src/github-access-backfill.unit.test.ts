/**
 * admin/src/github-access-backfill.unit.test.ts
 * Ordering, definitive-vs-error, backoff cap, terminal state and rate-limit
 * stop of backfillAccess (GLC-1.3), against in-memory ports.
 */

import { describe, expect, it } from "bun:test";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import {
  type AccessBackfillStore,
  type AccessProbe,
  type AccessRow,
  backfillAccess,
  buildWorkList,
  defaultAccessBackoffMs,
} from "./github-access-backfill.ts";
import {
  GithubLookupRateLimitError,
  type LookupRateLimit,
  type RepoRole,
} from "./github-lookup-client.ts";
import type { AccessInput } from "./github-repo-cache.ts";

const T0 = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const noLimit: LookupRateLimit = {
  remaining: 4000,
  resetAt: null,
  retryAfterSeconds: null,
};
const snapshotKey = {
  accountId: "acc",
  appKind: "lookup" as const,
  appRef: "555",
  org: "acme",
};

function makeStore(initial: AccessRow[] = [], user = "octocat") {
  const rows = new Map<
    string,
    AccessRow & { canPush?: boolean; level?: string | null }
  >();
  for (const r of initial) rows.set(`${user}/${r.repo}`, r);
  let snap: { rateLimitResetAt: Date | null } | null = null;
  const writes: AccessInput[] = [];
  const store: AccessBackfillStore = {
    async getAccessRows(q) {
      return q.repos.flatMap((r) => {
        const row = rows.get(`${q.username}/${r}`);
        return row ? [row] : [];
      });
    },
    async upsertAccess(i) {
      writes.push(i);
      rows.set(`${i.username}/${i.repo}`, {
        repo: i.repo,
        status: i.status,
        checkedAt: T0,
        attempts: i.attempts ?? 0,
        nextAttemptAt: i.nextAttemptAt ?? null,
        canPush: i.canPush,
        level: i.level,
      });
    },
    async getSnapshot() {
      return snap;
    },
    async upsertSnapshot(_k, p) {
      snap = { rateLimitResetAt: p?.rateLimitResetAt ?? null };
      return snap;
    },
  };
  return { store, rows, writes, snap: () => snap };
}

function probeOf(
  fn: (repo: string, user: string) => RepoRole | Error,
  calls: string[] = [],
): AccessProbe {
  return {
    async getCollaboratorPermissionWithRateLimit(_o, repo, user) {
      calls.push(`${user}/${repo}`);
      const out = fn(repo, user);
      if (out instanceof Error) throw out;
      return { role: out, rateLimit: noLimit };
    },
  };
}

const run = (
  h: ReturnType<typeof makeStore>,
  probe: AccessProbe,
  extra: Partial<Parameters<typeof backfillAccess>[0]> = {},
  now = T0,
) =>
  backfillAccess({
    accountId: "acc",
    org: "acme",
    snapshotKey,
    repos: ["a", "b", "c"],
    users: [{ username: "octocat" }],
    probe,
    store: h.store,
    clock: { now: () => now },
    maxAgeMs: DAY,
    ...extra,
  });

const row = (repo: string, over: Partial<AccessRow> = {}): AccessRow => ({
  repo,
  status: "ok",
  checkedAt: T0,
  attempts: 0,
  nextAttemptAt: null,
  ...over,
});

describe("buildWorkList ordering", () => {
  it("puts missing before expired, and configured repos first within each", () => {
    const { work, unanswered } = buildWorkList({
      username: "u",
      repos: ["a", "b", "c", "d", "e"],
      configuredRepos: ["e", "b"],
      rows: [
        row("a", { checkedAt: new Date(T0.getTime() - 2 * DAY) }), // expired
        row("b", { checkedAt: new Date(T0.getTime() - 2 * DAY) }), // expired, configured
        row("c"), // fresh
      ],
      now: T0,
      maxAgeMs: DAY,
    });
    expect(work.map((w) => `${w.kind}:${w.repo}`)).toEqual([
      "missing:e",
      "missing:d",
      "expired:b",
      "expired:a",
    ]);
    expect(unanswered).toBe(2);
  });

  it("skips terminal rows and rows still backing off, but counts backing-off as unanswered", () => {
    const { work, unanswered } = buildWorkList({
      username: "u",
      repos: ["a", "b", "c"],
      configuredRepos: [],
      rows: [
        row("a", { status: "terminal", attempts: 5 }),
        row("b", {
          status: "error",
          attempts: 1,
          nextAttemptAt: new Date(T0.getTime() + 1000),
        }),
        row("c", {
          status: "error",
          attempts: 1,
          nextAttemptAt: new Date(T0.getTime() - 1000),
        }),
      ],
      now: T0,
      maxAgeMs: DAY,
    });
    expect(work.map((w) => w.repo)).toEqual(["c"]);
    expect(unanswered).toBe(2);
  });
});

describe("backfillAccess", () => {
  it("stores a real no-access as ok/none and a 404 the same way", async () => {
    const h = makeStore();
    const out = await run(
      h,
      probeOf((repo) =>
        repo === "a"
          ? "none"
          : repo === "b"
            ? new GithubEnterpriseError("not_found", "nf", { status: 404 })
            : "write",
      ),
    );
    expect(out).toMatchObject({
      outcome: "complete",
      recorded: 3,
      failed: 0,
      missing: 0,
    });
    const by = Object.fromEntries(h.writes.map((w) => [w.repo, w]));
    expect(by.a).toMatchObject({ status: "ok", canPush: false, level: "none" });
    expect(by.b).toMatchObject({ status: "ok", canPush: false, level: "none" });
    expect(by.c).toMatchObject({ status: "ok", canPush: true, level: "write" });
  });

  it("never writes an access answer for an error; pair stays missing with backoff", async () => {
    const h = makeStore();
    const err = new GithubEnterpriseError("server", "boom", { status: 503 });
    const out = await run(
      h,
      probeOf((r) => (r === "a" ? err : "read")),
    );
    expect(out).toMatchObject({
      outcome: "in_progress",
      recorded: 2,
      failed: 1,
      missing: 1,
    });
    const w = h.writes.find((x) => x.repo === "a");
    expect(w).toMatchObject({
      status: "error",
      canPush: false,
      level: null,
      attempts: 1,
    });
    expect(w?.nextAttemptAt).toEqual(new Date(T0.getTime() + 60_000));
  });

  it("caps backoff and turns the pair terminal at maxAttempts, which stops blocking completion", async () => {
    expect(defaultAccessBackoffMs(1)).toBe(60_000);
    expect(defaultAccessBackoffMs(2)).toBe(120_000);
    expect(defaultAccessBackoffMs(40)).toBe(3_600_000);

    const h = makeStore();
    const err = new GithubEnterpriseError("server", "boom", { status: 500 });
    let now = T0;
    const probe = probeOf((r) => (r === "a" ? err : "read"));
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await run(h, probe, { maxAttempts: 3, repos: ["a", "b"] }, now),
      );
      now = new Date(now.getTime() + 3_600_001);
    }
    expect(results.map((r) => r.outcome)).toEqual([
      "in_progress",
      "in_progress",
      "complete",
    ]);
    expect(results[2]).toMatchObject({ terminal: 1, missing: 0 });
    expect(h.rows.get("octocat/a")?.status).toBe("terminal");

    const calls: string[] = [];
    const again = await run(
      h,
      probeOf(() => "read", calls),
      { maxAttempts: 3, repos: ["a", "b"] },
      now,
    );
    expect(calls).toEqual([]);
    expect(again).toMatchObject({ outcome: "complete", probed: 0, missing: 0 });
  });

  it("does not call for pairs still backing off", async () => {
    const h = makeStore();
    const calls: string[] = [];
    const err = new GithubEnterpriseError("network", "down");
    await run(
      h,
      probeOf(() => err, calls),
      { repos: ["a"] },
    );
    await run(
      h,
      probeOf(() => "read", calls),
      { repos: ["a"] },
      new Date(T0.getTime() + 1000),
    );
    expect(calls).toEqual(["octocat/a"]);
  });

  it("probes missing before expired, configured first, and shares rows across agents with one user", async () => {
    const h = makeStore([
      row("a", { checkedAt: new Date(T0.getTime() - 2 * DAY) }),
    ]);
    const calls: string[] = [];
    await run(
      h,
      probeOf(() => "read", calls),
      {
        repos: ["a", "b", "c"],
        users: [
          { username: "OctoCat", configuredRepos: ["c"] },
          { username: "octocat", configuredRepos: [] },
        ],
      },
    );
    expect(calls).toEqual(["octocat/c", "octocat/b", "octocat/a"]);
  });

  it("stops cleanly on a rate limit, writes no row for it, and resumes without redoing finished pairs", async () => {
    const h = makeStore();
    const reset = new Date(T0.getTime() + 600_000);
    const limited = new GithubLookupRateLimitError(
      new GithubEnterpriseError("rate_limit", "slow down", { status: 429 }),
      reset,
    );
    const first = await run(
      h,
      probeOf((r) => (r === "b" ? limited : "read")),
    );
    expect(first).toMatchObject({
      outcome: "rate_limited",
      recorded: 1,
      failed: 0,
      rateLimitResetAt: reset,
    });
    expect(h.rows.has("octocat/b")).toBe(false);
    expect(h.snap()?.rateLimitResetAt).toEqual(reset);

    const calls: string[] = [];
    const early = await run(
      h,
      probeOf(() => "read", calls),
      {},
      new Date(T0.getTime() + 1000),
    );
    expect(early).toMatchObject({
      outcome: "rate_limited",
      probed: 0,
      missing: 2,
    });
    expect(calls).toEqual([]);

    const later = await run(
      h,
      probeOf(() => "read", calls),
      {},
      new Date(reset.getTime() + 1),
    );
    expect(calls).toEqual(["octocat/b", "octocat/c"]);
    expect(later).toMatchObject({ outcome: "complete", recorded: 2 });
  });

  it("stops after an answer when X-RateLimit-Remaining is low", async () => {
    const h = makeStore();
    const resetAt = new Date(T0.getTime() + 300_000);
    const probe: AccessProbe = {
      async getCollaboratorPermissionWithRateLimit() {
        return {
          role: "read",
          rateLimit: { remaining: 3, resetAt, retryAfterSeconds: null },
        };
      },
    };
    const out = await run(h, probe);
    expect(out).toMatchObject({
      outcome: "rate_limited",
      probed: 1,
      recorded: 1,
      missing: 2,
      rateLimitResetAt: resetAt,
    });
  });
});

describe("backfillAccess: shouldStop (GLC-1.4 time budget)", () => {
  it("makes at least one probe, then stops in_progress when asked", async () => {
    const h = makeStore();
    const calls: string[] = [];
    let n = 0;
    const out = await run(
      h,
      probeOf(() => "write", calls),
      { shouldStop: () => ++n > 1 },
    );
    expect(out.outcome).toBe("in_progress");
    expect(calls).toEqual(["octocat/a", "octocat/b"]);
    expect(out.missing).toBe(1);
  });
});
