/**
 * admin/src/github-access-backfill.integration.test.ts
 * backfillAccess end to end: GithubLookupClient replaying recorded cassettes
 * (fixtures/github-lookup-cassette.json) through an INJECTED fetchFn, persisting
 * through GitHubRepoCacheService into a real PostgreSQL DB. Covers a 404, a 5xx
 * and a rate limit mid-run.
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../prisma/client/client.ts";
import { backfillAccess } from "./github-access-backfill.ts";
import { GithubLookupClient } from "./github-lookup-client.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

interface CassetteEntry {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(
    new URL("./fixtures/github-lookup-cassette.json", import.meta.url).pathname,
    "utf-8",
  ),
);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const T0 = new Date("2026-11-20T12:00:00Z");
const snapshotKey = {
  accountId: "acc",
  appKind: "lookup" as const,
  appRef: "555",
  org: "acme-eng",
};

describeOrSkip(
  "backfillAccess through GithubLookupClient (integration)",
  () => {
    let prisma: PrismaClient;
    let now: Date;
    let svc: GitHubRepoCacheService;
    let client: GithubLookupClient;
    /** Permission cassette per repo name. */
    let perms: Record<string, string>;
    let calls: string[];

    const clock = { now: () => new Date(now) };
    const run = (repos = ["api", "web", "infra"]) =>
      backfillAccess({
        accountId: "acc",
        org: "acme-eng",
        snapshotKey,
        repos,
        users: [{ username: "octocat", configuredRepos: ["infra"] }],
        probe: client,
        store: svc,
        clock,
        maxAgeMs: 86_400_000,
        maxAttempts: 2,
      });
    const accessRows = async () =>
      Object.fromEntries(
        (await prisma.gitHubRepoAccess.findMany()).map((r) => [r.repo, r]),
      );

    beforeEach(async () => {
      prisma = createAdminPrismaClient(TEST_DB as string);
      await prisma.gitHubRepoAccess.deleteMany();
      await prisma.gitHubCachedRepo.deleteMany();
      await prisma.gitHubRepoSnapshot.deleteMany();
      now = T0;
      svc = new GitHubRepoCacheService(prisma, clock);
      await svc.upsertSnapshot(snapshotKey);
      perms = {};
      calls = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(input.toString());
        const route = `${init?.method ?? "GET"} ${u.pathname}`;
        let name: string | undefined;
        if (route === "GET /orgs/acme-eng/installation") {
          name = "org_installation_success";
        } else if (route === "POST /app/installations/7001/access_tokens") {
          name = "lookup_token_success";
        } else {
          const m = u.pathname.match(
            /^\/repos\/acme-eng\/([^/]+)\/collaborators\/octocat\/permission$/,
          );
          if (m) {
            calls.push(m[1] as string);
            name = perms[m[1] as string];
          }
        }
        const entry = name ? cassette[name] : undefined;
        if (!entry) throw new Error(`no cassette for ${route}`);
        return new Response(JSON.stringify(entry.body), {
          status: entry.status,
          headers: {
            "Content-Type": "application/json",
            ...(entry.headers ?? {}),
          },
        });
      }) as typeof fetch;
      client = new GithubLookupClient({
        appId: "555",
        privateKey,
        apiBase: "https://ghe.test",
        fetchFn,
        now: clock.now,
      });
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("records a 404 as no-access and a 5xx as an error with no answer", async () => {
      perms = {
        infra: "permission_write",
        api: "permission_404",
        web: "permission_500",
      };
      const out = await run();
      expect(out).toMatchObject({
        outcome: "in_progress",
        recorded: 2,
        failed: 1,
        missing: 1,
      });
      expect(calls).toEqual(["infra", "api", "web"]);
      const rows = await accessRows();
      expect(rows.infra).toMatchObject({
        status: "ok",
        canPush: true,
        level: "write",
      });
      expect(rows.api).toMatchObject({
        status: "ok",
        canPush: false,
        level: "none",
      });
      expect(rows.web).toMatchObject({
        status: "error",
        canPush: false,
        level: null,
        attempts: 1,
      });
      expect(rows.web?.nextAttemptAt).not.toBeNull();
    });

    it("goes terminal after the attempts cap, then completes without blocking on it", async () => {
      perms = { api: "permission_read", web: "permission_503" };
      await run(["api", "web"]);
      now = new Date(T0.getTime() + 2 * 3_600_000);
      const out = await run(["api", "web"]);
      expect(out).toMatchObject({
        outcome: "complete",
        terminal: 1,
        missing: 0,
      });
      expect((await accessRows()).web?.status).toBe("terminal");
      calls = [];
      now = new Date(T0.getTime() + 3 * 3_600_000);
      await run(["api", "web"]);
      expect(calls).toEqual([]);
    });

    it("stops on a mid-run rate limit and resumes after the reset without redoing finished pairs", async () => {
      perms = {
        infra: "permission_read",
        api: "permission_429",
        web: "permission_read",
      };
      const first = await run();
      expect(first).toMatchObject({
        outcome: "rate_limited",
        recorded: 1,
        failed: 0,
      });
      expect(Object.keys(await accessRows())).toEqual(["infra"]);
      const snap = await svc.getSnapshot(snapshotKey);
      expect(snap?.rateLimitResetAt).toEqual(first.rateLimitResetAt as Date);

      calls = [];
      perms.api = "permission_read";
      const early = await run();
      expect(early).toMatchObject({ outcome: "rate_limited", probed: 0 });
      expect(calls).toEqual([]);

      now = new Date((first.rateLimitResetAt as Date).getTime() + 1000);
      const resumed = await run();
      expect(calls).toEqual(["api", "web"]);
      expect(resumed).toMatchObject({ outcome: "complete", recorded: 2 });
    });
  },
);
