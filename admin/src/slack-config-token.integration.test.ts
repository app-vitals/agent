/**
 * Integration tests for SlackConfigTokenService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import {
  SlackConfigTokenEncryptionUnavailableError,
  SlackConfigTokenService,
  toSlackConfigTokenMetadata,
} from "./slack-config-token.ts";
import { makeStrictTokenCrypto } from "./token-crypto.ts";

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
