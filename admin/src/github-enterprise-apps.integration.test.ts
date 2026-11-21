/**
 * Integration tests for GitHubEnterpriseAppService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import {
  GitHubEnterpriseAppService,
  PrivateKeyDecryptError,
  PrivateKeyEncryptionUnavailableError,
} from "./github-enterprise-apps.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { makeStrictTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nSUPERSECRETPEMBODY0123456789\n-----END RSA PRIVATE KEY-----";

const installer = {
  role: "installer" as const,
  appId: "111",
  slug: "inst-app",
  enterpriseSlug: "acme",
  privateKey: PEM,
};

describeOrSkip("GitHubEnterpriseAppService (integration)", () => {
  let prisma: PrismaClient;
  let service: GitHubEnterpriseAppService;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubEnterpriseApp.deleteMany();
    service = new GitHubEnterpriseAppService(
      prisma,
      makeStrictTokenCrypto(KEY_A),
    );
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("returns null when nothing is saved (feature off)", async () => {
    expect(await service.get("installer")).toBeNull();
    expect(await service.list()).toEqual([]);
  });

  it("saves and reads per role; metadata plus keySet only", async () => {
    const saved = await service.save(installer);
    expect(saved.keySet).toBe(true);
    await service.save({
      role: "lookup",
      appId: "222",
      slug: "look-app",
      privateKey: PEM,
    });
    const got = await service.get("installer");
    expect(got).toMatchObject({
      role: "installer",
      appId: "111",
      slug: "inst-app",
      enterpriseSlug: "acme",
      keySet: true,
    });
    expect(JSON.stringify(got)).not.toContain("SUPERSECRETPEMBODY");
    expect(JSON.stringify(await service.list())).not.toContain(
      "SUPERSECRETPEMBODY",
    );
    expect((await service.list()).map((a) => a.role).sort()).toEqual([
      "installer",
      "lookup",
    ]);
  });

  it("save again for the same role replaces the row (at most two rows)", async () => {
    await service.save(installer);
    await service.save({ ...installer, appId: "999" });
    expect(await prisma.gitHubEnterpriseApp.count()).toBe(1);
    expect((await service.get("installer"))?.appId).toBe("999");
  });

  it("stores the key encrypted and round-trips it via getPrivateKey", async () => {
    await service.save(installer);
    const row = await prisma.gitHubEnterpriseApp.findFirst({
      where: { role: "installer" },
    });
    expect(row?.privateKeyEncrypted).not.toContain("SUPERSECRETPEMBODY");
    expect(row?.privateKeyEncrypted.split(":")).toHaveLength(3);
    expect(await service.getPrivateKey("installer")).toBe(PEM);
  });

  it("deletes per role", async () => {
    await service.save(installer);
    await service.delete("installer");
    expect(await service.get("installer")).toBeNull();
    await service.delete("installer"); // no-op
  });

  it("rejects an unknown role", async () => {
    await expect(
      service.save({ ...installer, role: "bogus" as never }),
    ).rejects.toThrow(/role/);
  });

  it("refuses to save when no encryption key is configured, without echoing the PEM", async () => {
    const noKey = new GitHubEnterpriseAppService(
      prisma,
      makeStrictTokenCrypto(undefined),
    );
    const err = await noKey.save(installer).catch((e) => e);
    expect(err).toBeInstanceOf(PrivateKeyEncryptionUnavailableError);
    expect(err.message).toContain("SHIPWRIGHT_ENCRYPTION_KEY");
    expect(err.message).not.toContain("SUPERSECRETPEMBODY");
    expect(await prisma.gitHubEnterpriseApp.count()).toBe(0);
  });

  it("strict decrypt: wrong key throws, never returning ciphertext or PEM", async () => {
    await service.save(installer);
    const wrong = new GitHubEnterpriseAppService(
      prisma,
      makeStrictTokenCrypto(KEY_B),
    );
    const err = await wrong.getPrivateKey("installer").catch((e) => e);
    expect(err).toBeInstanceOf(PrivateKeyDecryptError);
    expect(err.message).not.toContain("SUPERSECRETPEMBODY");
  });

  it("strict decrypt: tampered and legacy plain-text values throw", async () => {
    await service.save(installer);
    const row = await prisma.gitHubEnterpriseApp.findFirst({
      where: { role: "installer" },
    });
    const [iv, ct, tag] = (row?.privateKeyEncrypted ?? "").split(":");
    const flipped = (ct[0] === "0" ? "1" : "0") + ct.slice(1);
    for (const bad of [`${iv}:${flipped}:${tag}`, PEM]) {
      await prisma.gitHubEnterpriseApp.update({
        where: { id: row?.id },
        data: { privateKeyEncrypted: bad },
      });
      const err = await service.getPrivateKey("installer").catch((e) => e);
      expect(err).toBeInstanceOf(PrivateKeyDecryptError);
      expect(err.message).not.toContain("SUPERSECRETPEMBODY");
    }
  });

  describe("account scope", () => {
    const lookup = { ...installer, role: "lookup" as const, appId: "900" };
    let acctA: string;
    let acctB: string;

    beforeEach(async () => {
      await prisma.account.deleteMany({
        where: { name: { in: ["ghe-a", "ghe-b"] } },
      });
      acctA = (await prisma.account.create({ data: { name: "ghe-a" } })).id;
      acctB = (await prisma.account.create({ data: { name: "ghe-b" } })).id;
    });

    afterEach(async () => {
      await prisma.gitHubEnterpriseApp.deleteMany();
      await prisma.account.deleteMany({
        where: { id: { in: [acctA, acctB] } },
      });
    });

    it("get(role, accountId) prefers the account row, else falls back to deployment-wide", async () => {
      await service.save(lookup);
      expect((await service.get("lookup", acctA))?.appId).toBe("900");
      await service.save({ ...lookup, accountId: acctA, appId: "901" });
      const own = await service.get("lookup", acctA);
      expect(own?.appId).toBe("901");
      expect(own?.accountId).toBe(acctA);
      expect((await service.get("lookup", acctB))?.appId).toBe("900");
      expect((await service.get("lookup"))?.appId).toBe("900");
    });

    it("listAccountIds returns each account with Apps of its own once, never the deployment scope", async () => {
      await service.save(lookup);
      expect(await service.listAccountIds()).toEqual([]);
      await service.save({ ...lookup, accountId: acctA });
      await service.save({ ...installer, accountId: acctA });
      await service.save({ ...installer, accountId: acctB });
      expect((await service.listAccountIds()).sort()).toEqual(
        [acctA, acctB].sort(),
      );
    });

    it("get(role) without accountId never sees an account row", async () => {
      await service.save({ ...lookup, accountId: acctA });
      expect(await service.get("lookup")).toBeNull();
      expect(await service.list()).toEqual([]);
      expect(await service.list(acctA)).toHaveLength(1);
    });

    it("accounts are isolated: save/delete/recordValidation hit only the targeted row", async () => {
      await service.save(lookup);
      await service.save({ ...lookup, accountId: acctA, appId: "A" });
      await service.save({ ...lookup, accountId: acctB, appId: "B" });
      await service.recordValidation("lookup", { status: "ok" }, acctA);
      expect((await service.get("lookup", acctA))?.lastValidationStatus).toBe(
        "ok",
      );
      expect((await service.get("lookup", acctB))?.lastValidationStatus).toBe(
        null,
      );
      expect((await service.get("lookup"))?.lastValidationStatus).toBe(null);
      await service.delete("lookup", acctA);
      expect((await service.get("lookup", acctA))?.appId).toBe("900");
      expect((await service.get("lookup", acctB))?.appId).toBe("B");
      expect(await prisma.gitHubEnterpriseApp.count()).toBe(2);
    });

    it("getPrivateKey follows the same fallback and decrypts the right row", async () => {
      await service.save(lookup);
      await service.save({
        ...lookup,
        accountId: acctA,
        privateKey: `${PEM}-ACCT`,
      });
      expect(await service.getPrivateKey("lookup", acctA)).toBe(`${PEM}-ACCT`);
      expect(await service.getPrivateKey("lookup", acctB)).toBe(PEM);
      expect(await service.getPrivateKey("lookup")).toBe(PEM);
    });

    it("save is idempotent per (accountId, role), including the NULL scope", async () => {
      await service.save(lookup);
      await service.save({ ...lookup, appId: "again" });
      await service.save({ ...lookup, accountId: acctA });
      await service.save({ ...lookup, accountId: acctA, appId: "again" });
      expect(await prisma.gitHubEnterpriseApp.count()).toBe(2);
    });

    it("the database rejects a second deployment-wide row for a role", async () => {
      await service.save(lookup);
      const dup = async () =>
        prisma.gitHubEnterpriseApp.create({
          data: {
            role: "lookup",
            appId: "x",
            slug: "x",
            privateKeyEncrypted: "x",
          },
        });
      await expect(dup()).rejects.toThrow();
    });

    it("deleting an account cascades to its apps only", async () => {
      await service.save(lookup);
      await service.save({ ...lookup, accountId: acctA });
      await prisma.account.delete({ where: { id: acctA } });
      expect(await prisma.gitHubEnterpriseApp.count()).toBe(1);
    });
  });
});
