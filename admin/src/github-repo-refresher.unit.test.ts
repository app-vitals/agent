/**
 * admin/src/github-repo-refresher.unit.test.ts
 * The GLC-1.4 refresh tick against an in-memory store and a fake clock:
 * per-org priority (missing before expired, staleness cap), the per-org
 * lease, the in-process overlap guard, the time budget, rate-limit skips and
 * failure isolation.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type {
  AccessProbe,
  AccessRow,
  BackfillUser,
} from "./github-access-backfill.ts";
import type {
  AccessInput,
  SnapshotKey,
  SnapshotProgress,
} from "./github-repo-cache.ts";
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_REFRESH_STALENESS_CAP_MS,
  DEFAULT_REFRESH_TIME_BUDGET_MS,
  DEFAULT_REFRESH_TTL_MS,
  GithubRepoRefresher,
  planOrgWork,
  type RefreshSnapshot,
  type RefreshStore,
  type RefreshTarget,
  resolveRefreshConfig,
  type StepOutcome,
} from "./github-repo-refresher.ts";

const T0 = new Date("2026-11-20T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const TTL = HOUR;
const CAP = 6 * HOUR;
const BUDGET = 30_000;

class ManualClock {
  t = T0.getTime();
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const keyStr = (k: SnapshotKey) =>
  `${k.accountId}|${k.appKind}|${k.appRef}|${k.org}`;

type Snap = RefreshSnapshot & {
  leaseHolder: string | null;
  leasedUntil: Date | null;
};

class MemoryStore implements RefreshStore {
  snaps = new Map<string, Snap>();
  repos = new Map<string, string[]>();
  access = new Map<string, AccessRow & { username: string }>();
  released: string[] = [];
  private seq = 0;

  constructor(private readonly clock: ManualClock) {}

  async getSnapshot(key: SnapshotKey) {
    const s = this.snaps.get(keyStr(key));
    return s ? { ...s } : null;
  }

  async upsertSnapshot(key: SnapshotKey, progress: SnapshotProgress = {}) {
    const k = keyStr(key);
    const base: Snap = this.snaps.get(k) ?? {
      id: `snap${++this.seq}`,
      completedAt: null,
      crawlStartedAt: null,
      nextAttemptAt: null,
      rateLimitResetAt: null,
      lastTickAt: null,
      lastError: null,
      leaseHolder: null,
      leasedUntil: null,
    };
    const next = { ...base } as Record<string, unknown>;
    for (const [f, v] of Object.entries(progress)) {
      if (v !== undefined) next[f] = v;
    }
    this.snaps.set(k, next as unknown as Snap);
    return { ...(next as unknown as Snap) };
  }

  byId(id: string): Snap | undefined {
    return [...this.snaps.values()].find((s) => s.id === id);
  }

  async acquireLease(id: string, holder: string, ttlMs: number) {
    const s = this.byId(id);
    if (!s) return false;
    const now = this.clock.now();
    if (s.leasedUntil && s.leasedUntil > now) return false;
    s.leaseHolder = holder;
    s.leasedUntil = new Date(now.getTime() + ttlMs);
    return true;
  }

  async releaseLease(id: string, holder: string) {
    const s = this.byId(id);
    if (s && s.leaseHolder === holder) {
      s.leaseHolder = null;
      s.leasedUntil = null;
      this.released.push(id);
    }
  }

  async listRepoFullNames(id: string) {
    return [...(this.repos.get(id) ?? [])].sort();
  }

  async getAccessRows(q: {
    accountId: string;
    org: string;
    username: string;
    repos: string[];
  }) {
    return q.repos.flatMap((r) => {
      const row = this.access.get(`${q.username}/${r}`);
      return row ? [row] : [];
    });
  }

  async upsertAccess(i: AccessInput) {
    this.access.set(`${i.username}/${i.repo}`, {
      username: i.username,
      repo: i.repo,
      status: i.status,
      checkedAt: this.clock.now(),
      attempts: i.attempts ?? 0,
      nextAttemptAt: i.nextAttemptAt ?? null,
    });
    return i;
  }

  /** Test helper: an ok access row checked at `checkedAt`. */
  setOk(username: string, repo: string, checkedAt: Date) {
    this.access.set(`${username}/${repo}`, {
      username,
      repo,
      status: "ok",
      checkedAt,
      attempts: 0,
      nextAttemptAt: null,
    });
  }
}

const lookupKey = (org: string): SnapshotKey => ({
  accountId: "acc",
  appKind: "lookup",
  appRef: "555",
  org,
});

let clock: ManualClock;
let store: MemoryStore;
let events: string[];

/** A fake crawl: on "complete" it writes `repos` and marks the snapshot done. */
function fakeCrawl(
  key: SnapshotKey,
  repos: string[],
  opts: {
    outcome?: StepOutcome["outcome"];
    costMs?: number;
    throws?: Error;
    rateLimitResetAt?: Date;
  } = {},
) {
  return async (ctx: { shouldStop: () => boolean }): Promise<StepOutcome> => {
    events.push(`crawl:${key.org}`);
    if (opts.costMs) clock.advance(opts.costMs);
    if (opts.throws) throw opts.throws;
    const outcome = opts.outcome ?? "complete";
    const snap = await store.upsertSnapshot(key, { lastTickAt: clock.now() });
    if (outcome === "complete") {
      store.repos.set(snap.id, repos);
      await store.upsertSnapshot(key, {
        crawlStartedAt: clock.now(),
        completedAt: clock.now(),
      });
    }
    if (outcome === "rate_limited") {
      await store.upsertSnapshot(key, {
        rateLimitResetAt: opts.rateLimitResetAt ?? null,
      });
    }
    void ctx;
    return opts.rateLimitResetAt
      ? { outcome, rateLimitResetAt: opts.rateLimitResetAt }
      : { outcome };
  };
}

function probe(costMs = 0): AccessProbe {
  return {
    async getCollaboratorPermissionWithRateLimit(org, repo, user) {
      events.push(`probe:${org}/${repo}@${user}`);
      if (costMs) clock.advance(costMs);
      return {
        role: "write",
        rateLimit: { remaining: 4000, resetAt: null, retryAfterSeconds: null },
      };
    },
  };
}

function target(
  org: string,
  over: Partial<RefreshTarget> & {
    repos?: string[];
    users?: BackfillUser[];
    crawlOpts?: Parameters<typeof fakeCrawl>[2];
  } = {},
): RefreshTarget {
  const key = over.key ?? lookupKey(org);
  const repos = over.repos ?? [`${org}/a`, `${org}/b`];
  return {
    key,
    crawl: over.crawl ?? fakeCrawl(key, repos, over.crawlOpts),
    ...(over.users
      ? { access: { probe: probe(), users: over.users } }
      : over.access
        ? { access: over.access }
        : {}),
  };
}

/** Seed a completed crawl at `completedAt` with `repos`. */
async function seedCrawl(key: SnapshotKey, repos: string[], completedAt: Date) {
  const snap = await store.upsertSnapshot(key, {
    crawlStartedAt: completedAt,
    completedAt,
    lastTickAt: completedAt,
  });
  store.repos.set(snap.id, repos);
  return snap;
}

function refresher(
  targets: RefreshTarget[] | (() => Promise<RefreshTarget[]>),
  over: Partial<ConstructorParameters<typeof GithubRepoRefresher>[0]> = {},
) {
  return new GithubRepoRefresher({
    discovery: {
      listTargets:
        typeof targets === "function" ? targets : async () => targets,
    },
    store,
    clock,
    config: {
      intervalMs: MIN,
      ttlMs: TTL,
      stalenessCapMs: CAP,
      timeBudgetMs: BUDGET,
    },
    holder: "worker-1",
    log: () => {},
    ...over,
  });
}

beforeEach(() => {
  clock = new ManualClock();
  store = new MemoryStore(clock);
  events = [];
});

// ─── resolveRefreshConfig ────────────────────────────────────────────────────

describe("resolveRefreshConfig", () => {
  it("defaults when unset, blank, non-numeric or non-positive", () => {
    const defaults = {
      intervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      ttlMs: DEFAULT_REFRESH_TTL_MS,
      stalenessCapMs: DEFAULT_REFRESH_STALENESS_CAP_MS,
      timeBudgetMs: DEFAULT_REFRESH_TIME_BUDGET_MS,
    };
    expect(resolveRefreshConfig({})).toEqual(defaults);
    expect(
      resolveRefreshConfig({
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_INTERVAL_MS: " ",
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_TTL_MS: "abc",
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_STALENESS_CAP_MS: "0",
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_TIME_BUDGET_MS: "-5",
      }),
    ).toEqual(defaults);
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBeLessThan(DEFAULT_REFRESH_TTL_MS);
    expect(DEFAULT_REFRESH_TIME_BUDGET_MS).toBeLessThan(
      DEFAULT_REFRESH_INTERVAL_MS,
    );
  });

  it("reads each value and never lets the staleness cap undercut the TTL", () => {
    expect(
      resolveRefreshConfig({
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_INTERVAL_MS: "30000",
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_TTL_MS: "7200000",
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_STALENESS_CAP_MS: "60000",
        SHIPWRIGHT_ADMIN_GITHUB_REFRESH_TIME_BUDGET_MS: "20000",
      }),
    ).toEqual({
      intervalMs: 30_000,
      ttlMs: 7_200_000,
      stalenessCapMs: 7_200_000,
      timeBudgetMs: 20_000,
    });
  });
});

// ─── planOrgWork ─────────────────────────────────────────────────────────────

describe("planOrgWork", () => {
  const snap = (over: Partial<RefreshSnapshot> = {}): RefreshSnapshot => ({
    id: "s",
    completedAt: null,
    crawlStartedAt: null,
    nextAttemptAt: null,
    rateLimitResetAt: null,
    lastTickAt: null,
    lastError: null,
    ...over,
  });
  const plan = (
    s: RefreshSnapshot,
    access?: { missing: number; expired: number; staleRepos: string[] },
  ) =>
    planOrgWork({
      snapshot: s,
      access,
      now: T0,
      ttlMs: TTL,
      stalenessCapMs: CAP,
    });
  const ago = (ms: number) => new Date(T0.getTime() - ms);
  const none = { missing: 0, expired: 0, staleRepos: [] };

  it("crawls a never-crawled org", () => {
    expect(plan(snap())).toEqual([{ kind: "crawl", reason: "missing" }]);
  });

  it("treats an incomplete list as missing and runs it before missing access", () => {
    expect(
      plan(snap({ crawlStartedAt: ago(MIN) }), { ...none, missing: 3 }),
    ).toEqual([
      { kind: "crawl", reason: "missing" },
      { kind: "access", reason: "missing" },
    ]);
  });

  it("holds expired work while anything is missing", () => {
    expect(
      plan(snap({ completedAt: ago(2 * HOUR) }), {
        missing: 2,
        expired: 5,
        staleRepos: [],
      }),
    ).toEqual([{ kind: "access", reason: "missing" }]);
  });

  it("runs expired work only when nothing is missing", () => {
    expect(
      plan(snap({ completedAt: ago(2 * HOUR) }), { ...none, expired: 1 }),
    ).toEqual([
      { kind: "crawl", reason: "expired" },
      { kind: "access", reason: "expired" },
    ]);
  });

  it("does nothing when everything is fresh", () => {
    expect(plan(snap({ completedAt: ago(MIN) }), none)).toEqual([]);
  });

  it("forces a crawl past the staleness cap even while backfill is pending", () => {
    expect(
      plan(snap({ completedAt: ago(CAP + 1) }), { ...none, missing: 9 }),
    ).toEqual([
      { kind: "crawl", reason: "stale_cap" },
      { kind: "access", reason: "missing" },
    ]);
  });

  it("forces access rows past the staleness cap ahead of missing access", () => {
    expect(
      plan(snap({ completedAt: ago(MIN) }), {
        missing: 4,
        expired: 2,
        staleRepos: ["old"],
      }),
    ).toEqual([
      { kind: "access", reason: "stale_cap", repos: ["old"] },
      { kind: "access", reason: "missing" },
    ]);
  });

  it("skips a crawl still backing off, which then does not hold expired access", () => {
    expect(
      plan(
        snap({
          crawlStartedAt: ago(MIN),
          nextAttemptAt: new Date(T0.getTime() + MIN),
        }),
        { ...none, expired: 1 },
      ),
    ).toEqual([{ kind: "access", reason: "expired" }]);
  });
});

// ─── tick ────────────────────────────────────────────────────────────────────

describe("GithubRepoRefresher.tick", () => {
  it("runs missing work before expired: crawl, unanswered pairs, then expired", async () => {
    const t = target("acme", {
      repos: ["acme/a", "acme/b", "acme/c"],
      users: [{ username: "octocat" }],
    });
    // An in-progress crawl (incomplete list) and an expired answer for "a".
    await store.upsertSnapshot(t.key, { crawlStartedAt: clock.now() });
    clock.advance(2 * HOUR);
    store.setOk("octocat", "a", new Date(T0.getTime() - HOUR));
    const res = await refresher([t]).tick();
    // The expired row for "a" waits until no pair is missing.
    expect(events).toEqual([
      "crawl:acme",
      "probe:acme/b@octocat",
      "probe:acme/c@octocat",
      "probe:acme/a@octocat",
    ]);
    expect(res.targets[0]?.steps).toEqual([
      "crawl:missing",
      "access:missing",
      "access:expired",
    ]);

    // Later: nothing missing, so the expired list and rows are refreshed.
    events = [];
    clock.advance(2 * HOUR);
    await refresher([t]).tick();
    expect(events).toEqual([
      "crawl:acme",
      "probe:acme/a@octocat",
      "probe:acme/b@octocat",
      "probe:acme/c@octocat",
    ]);
  });

  it("the staleness cap forces a refresh while backfill is still pending", async () => {
    const t = target("acme", {
      repos: ["acme/a", "acme/b", "acme/new"],
      access: {
        // Each probe eats the whole budget: backfill never finishes in a tick.
        probe: probe(BUDGET),
        users: [{ username: "octocat" }],
      },
    });
    await seedCrawl(t.key, ["acme/a", "acme/b"], T0);
    const r = refresher([t]);

    // Within the TTL... then expired, but pending backfill holds the crawl.
    clock.advance(2 * HOUR);
    await r.tick();
    expect(events).toEqual(["probe:acme/a@octocat"]);
    events = [];
    clock.advance(MIN);
    await r.tick();
    expect(events).toEqual(["probe:acme/b@octocat"]);

    // Past the cap the crawl runs first even though a pair is still missing.
    store.access.delete("octocat/b");
    events = [];
    clock.advance(CAP);
    await r.tick();
    expect(events[0]).toBe("crawl:acme");
  });

  it("skips an org whose lease another worker holds", async () => {
    const t = target("acme");
    const snap = await store.upsertSnapshot(t.key);
    expect(await store.acquireLease(snap.id, "worker-2", 10 * MIN)).toBe(true);
    const res = await refresher([t]).tick();
    expect(events).toEqual([]);
    expect(res.targets[0]?.state).toBe("leased_elsewhere");

    clock.advance(11 * MIN);
    const again = await refresher([t]).tick();
    expect(events).toEqual(["crawl:acme"]);
    expect(again.targets[0]?.state).toBe("worked");
    expect(store.byId(snap.id)?.leaseHolder).toBeNull();
  });

  it("an overlapping tick in the same process is a no-op", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const t = target("acme", {
      crawl: async () => {
        events.push("crawl:acme");
        await gate;
        return { outcome: "in_progress" };
      },
    });
    const r = refresher([t]);
    const first = r.tick();
    await Bun.sleep(0);
    const second = await r.tick();
    expect(second.skipped).toBe("overlap");
    release();
    await first;
    expect(events).toEqual(["crawl:acme"]);
    expect(r.status().running).toBe(false);
  });

  it("skips an org inside its rate-limit window and resumes after the reset", async () => {
    const resetAt = new Date(T0.getTime() + 10 * MIN);
    const t = target("acme");
    await store.upsertSnapshot(t.key, { rateLimitResetAt: resetAt });
    const r = refresher([t]);
    const res = await r.tick();
    expect(events).toEqual([]);
    expect(res.targets[0]).toMatchObject({
      state: "rate_limited",
      resumeAt: resetAt,
    });

    clock.advance(10 * MIN);
    await r.tick();
    expect(events).toEqual(["crawl:acme"]);
  });

  it("stops an org's remaining steps once a step hits a rate limit", async () => {
    const resetAt = new Date(T0.getTime() + 5 * MIN);
    const t = target("acme", {
      users: [{ username: "octocat" }],
      crawlOpts: { outcome: "rate_limited", rateLimitResetAt: resetAt },
    });
    await store.upsertSnapshot(t.key, { crawlStartedAt: T0 });
    const res = await refresher([t]).tick();
    expect(events).toEqual(["crawl:acme"]);
    expect(res.targets[0]).toMatchObject({
      state: "rate_limited",
      resumeAt: resetAt,
    });
  });

  it("one org failing never blocks the others, and its lease is released", async () => {
    const bad = target("bad", { crawlOpts: { throws: new Error("boom") } });
    const good = target("good");
    const res = await refresher([bad, good]).tick();
    expect(events).toEqual(["crawl:bad", "crawl:good"]);
    const byOrg = Object.fromEntries(res.targets.map((s) => [s.key.org, s]));
    expect(byOrg.bad).toMatchObject({ state: "error", error: "boom" });
    expect(byOrg.good?.state).toBe("worked");
    const badSnap = await store.getSnapshot(bad.key);
    expect(store.byId(badSnap?.id ?? "")?.leaseHolder).toBeNull();
  });

  it("stops starting work once the time budget is spent", async () => {
    const a = target("a", { crawlOpts: { costMs: BUDGET } });
    const b = target("b");
    const seen: boolean[] = [];
    const c: RefreshTarget = {
      key: lookupKey("c"),
      crawl: async (ctx) => {
        seen.push(ctx.shouldStop());
        return { outcome: "in_progress" };
      },
    };
    const res = await refresher([a, b, c]).tick();
    expect(events).toEqual(["crawl:a"]);
    expect(seen).toEqual([]);
    const states = res.targets.map((s) => `${s.key.org}:${s.state}`);
    expect(states).toEqual(["a:worked", "b:deferred", "c:deferred"]);
  });

  it("hands each step a shouldStop that turns true at the deadline", async () => {
    const seen: boolean[] = [];
    const t: RefreshTarget = {
      key: lookupKey("acme"),
      crawl: async (ctx) => {
        seen.push(ctx.shouldStop());
        clock.advance(BUDGET);
        seen.push(ctx.shouldStop());
        return { outcome: "in_progress" };
      },
    };
    await refresher([t]).tick();
    expect(seen).toEqual([false, true]);
  });

  it("works orgs with missing work before expired-only ones, least recently ticked first", async () => {
    const expired = target("expired");
    await seedCrawl(expired.key, [], new Date(T0.getTime() - 2 * HOUR));
    const missingOld = target("missing-old");
    await store.upsertSnapshot(missingOld.key, {
      crawlStartedAt: T0,
      lastTickAt: new Date(T0.getTime() - HOUR),
    });
    const missingNew = target("missing-new");
    await store.upsertSnapshot(missingNew.key, {
      crawlStartedAt: T0,
      lastTickAt: T0,
    });
    const fresh = target("fresh");
    await seedCrawl(fresh.key, [], T0);
    const res = await refresher([
      expired,
      missingNew,
      fresh,
      missingOld,
    ]).tick();
    expect(events).toEqual([
      "crawl:missing-old",
      "crawl:missing-new",
      "crawl:expired",
    ]);
    const freshStatus = res.targets.find((s) => s.key.org === "fresh");
    expect(freshStatus?.state).toBe("idle");
  });

  it("writes lastTickAt on each worked snapshot and on the refresher status", async () => {
    const t = target("acme", {
      crawl: async () => {
        clock.advance(1000);
        return { outcome: "in_progress" };
      },
    });
    const r = refresher([t]);
    expect(r.status().lastTickAt).toBeNull();
    await r.tick();
    expect((await store.getSnapshot(t.key))?.lastTickAt).toEqual(
      new Date(T0.getTime() + 1000),
    );
    const s = r.status();
    expect(s.lastTickAt).toEqual(T0);
    expect(s.targets[keyStr(t.key)]).toMatchObject({
      state: "worked",
      steps: ["crawl:missing"],
      outcome: "in_progress",
    });
  });

  it("never throws when discovery fails", async () => {
    const r = refresher(async () => {
      throw new Error("no installer");
    });
    const res = await r.tick();
    expect(res.targets).toEqual([]);
    expect(res.error).toBe("no installer");
    expect(r.status().lastTickAt).toEqual(T0);
  });

  it("caches discovery between ticks and refreshes it after the interval", async () => {
    let calls = 0;
    const r = refresher(
      async () => {
        calls++;
        return [];
      },
      { discoveryIntervalMs: 10 * MIN },
    );
    await r.tick();
    clock.advance(MIN);
    await r.tick();
    expect(calls).toBe(1);
    clock.advance(10 * MIN);
    await r.tick();
    expect(calls).toBe(2);
  });
});
