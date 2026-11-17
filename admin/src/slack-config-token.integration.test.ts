/**
 * Integration tests for SlackConfigTokenService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { Clock } from "./clock.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import {
  isSlackConfigTokenRevokedError,
  SlackConfigRefreshTokenInvalidError,
  SlackConfigTokenEncryptionUnavailableError,
  SlackConfigTokenNotConfiguredError,
  SlackConfigTokenService,
  toSlackConfigTokenMetadata,
} from "./slack-config-token.ts";
import {
  type SlackConfigTokenClient,
  SlackConfigTokenError,
} from "./slack-provisioning-client.ts";
import { makeStrictTokenCrypto, type TokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const KEY = "a".repeat(64);
const REFRESH = "test-refresh-SUPERSECRET";
const ACCESS = "test-access-SUPERSECRET";

describeOrSkip("SlackConfigTokenService (integration)", () => {
  let prisma: PrismaClient;
  let service: SlackConfigTokenService;
  let acctA: string;
  let acctB: string;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.slackConfigToken.deleteMany();
    await prisma.agentTemplateItem.deleteMany();
    await prisma.agentTemplate.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.account.deleteMany();
    acctA = (await prisma.account.create({ data: { name: "A" } })).id;
    acctB = (await prisma.account.create({ data: { name: "B" } })).id;
    service = new SlackConfigTokenService(prisma, makeStrictTokenCrypto(KEY));
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("returns null / empty when nothing is saved", async () => {
    expect(await service.get(null)).toBeNull();
    expect(await service.get(acctA)).toBeNull();
    expect(await service.resolveForAccount(acctA)).toBeNull();
    expect(await service.list()).toEqual([]);
  });

  it("saves, gets and clears per scope; metadata only", async () => {
    const exp = new Date("2030-01-01T00:00:00Z");
    const saved = await service.save(acctA, {
      refreshToken: REFRESH,
      accessToken: ACCESS,
      accessTokenExpiresAt: exp,
      slackTeamId: "T1",
      slackUserId: "U1",
    });
    expect(saved).toMatchObject({
      accountId: acctA,
      refreshTokenSet: true,
      accessTokenSet: true,
      slackTeamId: "T1",
      slackUserId: "U1",
    });
    expect(saved.accessTokenExpiresAt).toEqual(exp);
    expect(saved.lastRotatedAt).not.toBeNull();
    const got = await service.get(acctA);
    expect(got?.id).toBe(saved.id);
    for (const out of [saved, got, await service.list()]) {
      const json = JSON.stringify(out);
      expect(json).not.toContain("SUPERSECRET");
      expect(json).not.toContain("Encrypted");
    }
    // stored encrypted, not plain
    const raw = await prisma.slackConfigToken.findFirstOrThrow({
      where: { accountId: acctA },
    });
    expect(raw.refreshTokenEncrypted).not.toContain("SUPERSECRET");
    expect(raw.accessTokenEncrypted).not.toContain("SUPERSECRET");

    await service.clear(acctA);
    expect(await service.get(acctA)).toBeNull();
    await service.clear(acctA); // no-op
  });

  it("allows a token with no access token", async () => {
    const saved = await service.save(null, { refreshToken: REFRESH });
    expect(saved.accessTokenSet).toBe(false);
  });

  it("upserts one row per scope, including two NULL-scope saves", async () => {
    const first = await service.save(null, { refreshToken: REFRESH });
    const second = await service.save(null, {
      refreshToken: "test-refresh-OTHER",
      slackTeamId: "T2",
    });
    expect(second.id).toBe(first.id);
    expect(second.slackTeamId).toBe("T2");
    expect(
      await prisma.slackConfigToken.count({ where: { accountId: null } }),
    ).toBe(1);

    const a1 = await service.save(acctA, { refreshToken: REFRESH });
    const a2 = await service.save(acctA, { refreshToken: REFRESH });
    expect(a2.id).toBe(a1.id);
    await service.save(acctB, { refreshToken: REFRESH });
    expect(await prisma.slackConfigToken.count()).toBe(3);
  });

  it("enforces both partial unique indexes at the database", async () => {
    const base = { refreshTokenEncrypted: "x" };
    await prisma.slackConfigToken.create({
      data: { ...base, accountId: null },
    });
    await expect(
      (async () =>
        prisma.slackConfigToken.create({
          data: { ...base, accountId: null },
        }))(),
    ).rejects.toThrow();
    await prisma.slackConfigToken.create({
      data: { ...base, accountId: acctA },
    });
    await expect(
      (async () =>
        prisma.slackConfigToken.create({
          data: { ...base, accountId: acctA },
        }))(),
    ).rejects.toThrow();
  });

  it("resolveForAccount prefers the account row, then default, then null", async () => {
    expect(await service.resolveForAccount(acctA)).toBeNull();
    const def = await service.save(null, { refreshToken: REFRESH });
    expect((await service.resolveForAccount(acctA))?.id).toBe(def.id);
    const own = await service.save(acctA, { refreshToken: REFRESH });
    expect((await service.resolveForAccount(acctA))?.id).toBe(own.id);
    expect((await service.resolveForAccount(acctB))?.id).toBe(def.id);
    await service.clear(null);
    await service.clear(acctA);
    expect(await service.resolveForAccount(acctA)).toBeNull();
  });

  it("clears only the targeted scope", async () => {
    await service.save(null, { refreshToken: REFRESH });
    await service.save(acctA, { refreshToken: REFRESH });
    await service.clear(acctA);
    expect(await service.get(null)).not.toBeNull();
    expect(await service.get(acctA)).toBeNull();
  });

  it("deleting an account cascades its token", async () => {
    await service.save(acctA, { refreshToken: REFRESH });
    await prisma.account.delete({ where: { id: acctA } });
    expect(await prisma.slackConfigToken.count()).toBe(0);
  });

  it("refuses to save without an encryption key", async () => {
    const noKey = new SlackConfigTokenService(prisma, null);
    await expect(
      noKey.save(null, { refreshToken: REFRESH }),
    ).rejects.toBeInstanceOf(SlackConfigTokenEncryptionUnavailableError);
    expect(await prisma.slackConfigToken.count()).toBe(0);
  });
});

describe("toSlackConfigTokenMetadata", () => {
  it("never includes secret fields", () => {
    const now = new Date();
    const out = toSlackConfigTokenMetadata({
      id: "i",
      accountId: null,
      refreshTokenEncrypted: "SECRETREFRESHCIPHER",
      accessTokenEncrypted: "SECRETACCESSCIPHER",
      accessTokenExpiresAt: now,
      slackTeamId: "T",
      slackUserId: "U",
      lastRotatedAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(Object.keys(out).sort()).toEqual(
      [
        "id",
        "accountId",
        "refreshTokenSet",
        "accessTokenSet",
        "accessTokenExpiresAt",
        "slackTeamId",
        "slackUserId",
        "lastRotatedAt",
        "lastError",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.refreshTokenSet).toBe(true);
    expect(out.accessTokenSet).toBe(true);
  });
});

// ─── getAccessToken / withSlackConfigAccessToken ─────────────────────────────

class MutableClock implements Clock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

type RotateResult = Awaited<
  ReturnType<SlackConfigTokenClient["rotateConfigToken"]>
>;

/** Rotate client double: hands out a fresh numbered pair per call. */
class FakeRotateClient implements SlackConfigTokenClient {
  calls: string[] = [];
  delayMs = 0;
  failWith: SlackConfigTokenError | null = null;
  constructor(private clock: Clock) {}
  async rotateConfigToken(refreshToken: string): Promise<RotateResult> {
    this.calls.push(refreshToken);
    const n = this.calls.length;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return {
      accessToken: `rotated-access-${n}-SUPERSECRET`,
      refreshToken: `rotated-refresh-${n}-SUPERSECRET`,
      teamId: `T${n}`,
      userId: `U${n}`,
      iat,
      exp: iat + 12 * 3600,
    };
  }
}

const MIN = 60_000;

describeOrSkip("SlackConfigTokenService.getAccessToken (integration)", () => {
  let prisma: PrismaClient;
  let crypto: TokenCrypto;
  let clock: MutableClock;
  let rotate: FakeRotateClient;
  let service: SlackConfigTokenService;
  let acctA: string;

  const row = (accountId: string | null) =>
    prisma.slackConfigToken.findFirstOrThrow({ where: { accountId } });

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.slackConfigToken.deleteMany();
    await prisma.agentTemplateItem.deleteMany();
    await prisma.agentTemplate.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.account.deleteMany();
    acctA = (await prisma.account.create({ data: { name: "A" } })).id;
    crypto = makeStrictTokenCrypto(KEY) as TokenCrypto;
    // Whole seconds so exp (unix seconds) round-trips exactly.
    clock = new MutableClock(new Date("2030-01-01T00:00:00Z"));
    rotate = new FakeRotateClient(clock);
    service = new SlackConfigTokenService(prisma, crypto, clock, rotate);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("cache hit: returns the stored access token without calling Slack", async () => {
    await service.save(acctA, {
      refreshToken: REFRESH,
      accessToken: ACCESS,
      accessTokenExpiresAt: new Date(clock.now().getTime() + 11 * MIN),
    });
    expect(await service.getAccessToken(acctA)).toBe(ACCESS);
    expect(rotate.calls).toEqual([]);
  });

  it("rotates when the cached token has 10 minutes or less left, persisting the new pair", async () => {
    await service.save(null, {
      refreshToken: REFRESH,
      accessToken: ACCESS,
      accessTokenExpiresAt: new Date(clock.now().getTime() + 10 * MIN),
    });
    clock.advance(MIN);
    const token = await service.getAccessToken(null);
    expect(token).toBe("rotated-access-1-SUPERSECRET");
    expect(rotate.calls).toEqual([REFRESH]);

    const r = await row(null);
    expect(crypto.decrypt(r.refreshTokenEncrypted)).toBe(
      "rotated-refresh-1-SUPERSECRET",
    );
    expect(crypto.decrypt(r.accessTokenEncrypted as string)).toBe(token);
    expect(r.accessTokenExpiresAt).toEqual(
      new Date(clock.now().getTime() + 12 * 3600 * 1000),
    );
    expect(r.slackTeamId).toBe("T1");
    expect(r.slackUserId).toBe("U1");
    expect(r.lastRotatedAt).toEqual(clock.now());
    expect(r.lastError).toBeNull();

    // The persisted token is now a cache hit.
    expect(await service.getAccessToken(null)).toBe(token);
    expect(rotate.calls.length).toBe(1);
  });

  it("rotates when no access token is cached", async () => {
    await service.save(acctA, { refreshToken: REFRESH });
    expect(await service.getAccessToken(acctA)).toBe(
      "rotated-access-1-SUPERSECRET",
    );
    expect(rotate.calls).toEqual([REFRESH]);
  });

  it("uses the exact scope row only", async () => {
    await service.save(null, { refreshToken: REFRESH });
    await expect(service.getAccessToken(acctA)).rejects.toBeInstanceOf(
      SlackConfigTokenNotConfiguredError,
    );
    expect(rotate.calls).toEqual([]);
  });

  it("serializes concurrent callers on a stale token: exactly one rotate, same token for all", async () => {
    await service.save(acctA, {
      refreshToken: REFRESH,
      accessToken: ACCESS,
      accessTokenExpiresAt: new Date(clock.now().getTime() - MIN),
    });
    rotate.delayMs = 150;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.getAccessToken(acctA)),
    );
    expect(rotate.calls).toEqual([REFRESH]);
    expect(new Set(results)).toEqual(new Set(["rotated-access-1-SUPERSECRET"]));
  });

  it("serializes across service instances (replicas) too", async () => {
    await service.save(acctA, { refreshToken: REFRESH });
    rotate.delayMs = 150;
    const other = new SlackConfigTokenService(
      createAdminPrismaClient(TEST_DB as string),
      crypto,
      clock,
      rotate,
    );
    const results = await Promise.all([
      service.getAccessToken(acctA),
      other.getAccessToken(acctA),
      service.getAccessToken(acctA),
    ]);
    expect(rotate.calls.length).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("does not return the token when persisting the rotated pair fails", async () => {
    // A crypto whose ciphertext for the new refresh token contains a NUL byte,
    // which Postgres rejects in a TEXT column: a real write failure.
    const failing: TokenCrypto = {
      encrypt: (t) =>
        t.startsWith("rotated-refresh-")
          ? "bad\u0000cipher"
          : crypto.encrypt(t),
      decrypt: (t) => crypto.decrypt(t),
    };
    await service.save(acctA, { refreshToken: REFRESH });
    const broken = new SlackConfigTokenService(prisma, failing, clock, rotate);
    let caught: unknown;
    try {
      await broken.getAccessToken(acctA);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).not.toContain("SUPERSECRET");
    expect(rotate.calls.length).toBe(1);
    // Rolled back: the original pair is still stored.
    const r = await row(acctA);
    expect(crypto.decrypt(r.refreshTokenEncrypted)).toBe(REFRESH);
    expect(r.accessTokenEncrypted).toBeNull();
  });

  it("invalid_refresh_token records lastError and surfaces a regenerate error", async () => {
    await service.save(acctA, {
      refreshToken: REFRESH,
      accessToken: ACCESS,
      accessTokenExpiresAt: new Date(clock.now().getTime() - MIN),
    });
    const before = await row(acctA);
    rotate.failWith = new SlackConfigTokenError(
      "invalid_refresh_token",
      "Slack tooling.tokens.rotate failed: invalid_refresh_token",
    );
    let caught: unknown;
    try {
      await service.getAccessToken(acctA);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlackConfigRefreshTokenInvalidError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/regenerate/i);
    expect(msg).not.toContain("SUPERSECRET");
    const after = await row(acctA);
    expect(after.lastError).toContain("invalid_refresh_token");
    expect(after.lastError).not.toContain("SUPERSECRET");
    // Token material untouched.
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
    expect((await service.get(acctA))?.lastError).toBe(after.lastError);
  });

  it("other rotate errors record the code without touching tokens", async () => {
    await service.save(null, { refreshToken: REFRESH });
    const before = await row(null);
    rotate.failWith = new SlackConfigTokenError(
      "http_error",
      "Slack tooling.tokens.rotate HTTP error: 503 Service Unavailable",
    );
    await expect(service.getAccessToken(null)).rejects.toThrow(/http_error/);
    const after = await row(null);
    expect(after.lastError).toContain("http_error");
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
  });

  it("a successful rotate clears a previous lastError", async () => {
    await service.save(null, { refreshToken: REFRESH });
    rotate.failWith = new SlackConfigTokenError("http_error", "boom");
    await expect(service.getAccessToken(null)).rejects.toThrow();
    rotate.failWith = null;
    await service.getAccessToken(null);
    expect((await row(null)).lastError).toBeNull();
  });

  it("forceRotate rotates even with a valid cached token", async () => {
    await service.save(acctA, {
      refreshToken: REFRESH,
      accessToken: ACCESS,
      accessTokenExpiresAt: new Date(clock.now().getTime() + 11 * 3600 * 1000),
    });
    expect(await service.getAccessToken(acctA, { forceRotate: true })).toBe(
      "rotated-access-1-SUPERSECRET",
    );
    expect(rotate.calls).toEqual([REFRESH]);
  });

  it("forceRotate with rejectedAccessToken reuses a token another caller already rotated to", async () => {
    await service.save(acctA, { refreshToken: REFRESH, accessToken: ACCESS });
    // Another caller already rotated past the rejected token.
    await service.save(acctA, {
      refreshToken: "test-refresh-NEWER",
      accessToken: "test-access-NEWER",
      accessTokenExpiresAt: new Date(clock.now().getTime() + 11 * 3600 * 1000),
    });
    expect(
      await service.getAccessToken(acctA, {
        forceRotate: true,
        rejectedAccessToken: ACCESS,
      }),
    ).toBe("test-access-NEWER");
    expect(rotate.calls).toEqual([]);
    // Rejected token is still the stored one -> rotate.
    expect(
      await service.getAccessToken(acctA, {
        forceRotate: true,
        rejectedAccessToken: "test-access-NEWER",
      }),
    ).toBe("rotated-access-1-SUPERSECRET");
    expect(rotate.calls).toEqual(["test-refresh-NEWER"]);
  });

  it("clear errors for a missing row, a missing key and a missing rotate client", async () => {
    await expect(service.getAccessToken(acctA)).rejects.toBeInstanceOf(
      SlackConfigTokenNotConfiguredError,
    );
    await service.save(acctA, { refreshToken: REFRESH });
    await expect(
      new SlackConfigTokenService(prisma, null, clock, rotate).getAccessToken(
        acctA,
      ),
    ).rejects.toBeInstanceOf(SlackConfigTokenEncryptionUnavailableError);
    await expect(
      new SlackConfigTokenService(prisma, crypto, clock).getAccessToken(acctA),
    ).rejects.toThrow(/SlackConfigTokenClient/);
    expect(rotate.calls).toEqual([]);
  });

  describe("withSlackConfigAccessToken", () => {
    beforeEach(async () => {
      await service.save(acctA, {
        refreshToken: REFRESH,
        accessToken: ACCESS,
        accessTokenExpiresAt: new Date(
          clock.now().getTime() + 11 * 3600 * 1000,
        ),
      });
    });

    it("runs fn with the cached token", async () => {
      const seen: string[] = [];
      const out = await service.withSlackConfigAccessToken(acctA, async (t) => {
        seen.push(t);
        return 42;
      });
      expect(out).toBe(42);
      expect(seen).toEqual([ACCESS]);
      expect(rotate.calls).toEqual([]);
    });

    it("on token_revoked force-rotates once and retries, then passes", async () => {
      const seen: string[] = [];
      const out = await service.withSlackConfigAccessToken(acctA, async (t) => {
        seen.push(t);
        if (t === ACCESS) {
          // Shape thrown by HttpSlackProvisioningClient manifest calls.
          throw new Error("Slack apps.manifest.update failed: token_revoked");
        }
        return "ok";
      });
      expect(out).toBe("ok");
      expect(seen).toEqual([ACCESS, "rotated-access-1-SUPERSECRET"]);
      expect(rotate.calls).toEqual([REFRESH]);
    });

    it("retries at most once: a second auth failure propagates, no loop", async () => {
      let n = 0;
      await expect(
        service.withSlackConfigAccessToken(acctA, async () => {
          n++;
          throw new Error("Slack apps.manifest.delete failed: invalid_auth");
        }),
      ).rejects.toThrow(/invalid_auth/);
      expect(n).toBe(2);
      expect(rotate.calls.length).toBe(1);
    });

    it("does not retry on unrelated errors", async () => {
      let n = 0;
      await expect(
        service.withSlackConfigAccessToken(acctA, async () => {
          n++;
          throw new Error(
            "Slack apps.manifest.create failed: invalid_manifest",
          );
        }),
      ).rejects.toThrow(/invalid_manifest/);
      expect(n).toBe(1);
      expect(rotate.calls).toEqual([]);
    });
  });
});

describe("isSlackConfigTokenRevokedError", () => {
  it("matches manifest-call errors and coded errors for token_revoked / invalid_auth", () => {
    expect(
      isSlackConfigTokenRevokedError(
        new Error("Slack apps.manifest.update failed: token_revoked"),
      ),
    ).toBe(true);
    expect(
      isSlackConfigTokenRevokedError(
        new Error("Slack apps.manifest.create failed: invalid_auth"),
      ),
    ).toBe(true);
    expect(
      isSlackConfigTokenRevokedError(
        new SlackConfigTokenError("token_revoked", "x"),
      ),
    ).toBe(true);
    expect(
      isSlackConfigTokenRevokedError(
        new Error("Slack apps.manifest.create failed: invalid_manifest"),
      ),
    ).toBe(false);
    expect(
      isSlackConfigTokenRevokedError(
        new Error("Slack apps.manifest.update failed: not_authed_revoked_x"),
      ),
    ).toBe(false);
    expect(isSlackConfigTokenRevokedError("token_revoked")).toBe(false);
    expect(isSlackConfigTokenRevokedError(null)).toBe(false);
  });
});
