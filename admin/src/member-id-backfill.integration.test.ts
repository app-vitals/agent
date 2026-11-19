/**
 * admin/src/member-id-backfill.integration.test.ts (ACM-1.2)
 * Backfill over a seeded DB: matched, unmapped and overridden rows.
 *
 * Fixture emails mirror the shapes the live tables hold: lowercase matches,
 * mixed-case/whitespace variants of a member email, a departed user with no
 * member, and a renamed address that needs a hand-matched override. They were
 * NOT read from the live database (no access from the build environment);
 * ACM-1.3 (HITL dry-run on prod) is where observed values get reconciled.
 *
 * Requires DATABASE_URL_ADMIN_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { runMemberIdBackfill } from "./member-id-backfill.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("memberId backfill (integration)", () => {
  let prisma: PrismaClient;
  let aliceId: string;
  let carolId: string;

  async function seedRows(email: string, n = 1) {
    const agent = await prisma.agent.upsert({
      where: { id: "bf-agent" },
      update: {},
      create: { id: "bf-agent", name: "bf-agent" },
    });
    await prisma.userNotificationPrefs.create({ data: { userEmail: email } });
    for (let i = 0; i < n; i++) {
      await prisma.chatThreadWatch.create({
        data: {
          userEmail: email,
          threadId: `t-${email}-${i}`,
          agentId: agent.id,
        },
      });
    }
    await prisma.pushSubscription.create({
      data: {
        userEmail: email,
        endpoint: `ep-${email}`,
        p256dh: "p",
        auth: "a",
      },
    });
    await prisma.agentMember.create({ data: { agentId: agent.id, email } });
  }

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.userNotificationPrefs.deleteMany();
    await prisma.chatThreadWatch.deleteMany();
    await prisma.pushSubscription.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.account.deleteMany();
    const account = await prisma.account.create({ data: { name: "Acme" } });
    aliceId = (
      await prisma.accountMember.create({
        data: { accountId: account.id, email: "alice@acme.com", role: "owner" },
      })
    ).id;
    carolId = (
      await prisma.accountMember.create({
        data: {
          accountId: account.id,
          email: "carol@acme.com",
          role: "member",
        },
      })
    ).id;
    await seedRows("alice@acme.com", 2); // matched
    await seedRows("Alice@Acme.com "); // matched after normalization
    await seedRows("gone@old.com", 3); // unmapped
    await seedRows("carol.old@acme.com"); // overridden -> carol
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  const memberIds = async () => ({
    prefs: await prisma.userNotificationPrefs.findMany({
      orderBy: { userEmail: "asc" },
    }),
    watches: await prisma.chatThreadWatch.findMany(),
  });

  it("dry run changes nothing and reports unmapped emails with per-table counts", async () => {
    const report = await runMemberIdBackfill(prisma, { dryRun: true });
    expect(report.unmapped).toEqual([
      {
        email: "carol.old@acme.com",
        counts: {
          UserNotificationPrefs: 1,
          ChatThreadWatch: 1,
          PushSubscription: 1,
          AgentMember: 1,
        },
      },
      {
        email: "gone@old.com",
        counts: {
          UserNotificationPrefs: 1,
          ChatThreadWatch: 3,
          PushSubscription: 1,
          AgentMember: 1,
        },
      },
    ]);
    const { prefs, watches } = await memberIds();
    expect(prefs.every((p) => p.memberId === null)).toBe(true);
    expect(watches.every((w) => w.memberId === null)).toBe(true);
  });

  it("apply maps matched rows, leaves unmapped null, and is idempotent", async () => {
    const first = await runMemberIdBackfill(prisma, { dryRun: false });
    expect(first.mapped.ChatThreadWatch).toBe(3); // alice x2 + variant
    const prefs = await prisma.userNotificationPrefs.findMany();
    const idFor = (e: string) => prefs.find((p) => p.userEmail === e)?.memberId;
    expect(idFor("alice@acme.com")).toBe(aliceId);
    expect(idFor("Alice@Acme.com ")).toBe(aliceId);
    expect(idFor("gone@old.com")).toBeNull();
    expect(idFor("carol.old@acme.com")).toBeNull();

    const second = await runMemberIdBackfill(prisma, { dryRun: false });
    expect(Object.values(second.mapped).every((n) => n === 0)).toBe(true);
    expect(second.unmapped).toEqual(first.unmapped);
  });

  it("overrides take precedence over the automatic match and apply is idempotent", async () => {
    const overrides = new Map([
      ["carol.old@acme.com", carolId],
      ["alice@acme.com", carolId], // beats the automatic alice match
    ]);
    await runMemberIdBackfill(prisma, { dryRun: false });
    await runMemberIdBackfill(prisma, { dryRun: false, overrides });
    const again = await runMemberIdBackfill(prisma, {
      dryRun: false,
      overrides,
    });
    expect(Object.values(again.mapped).every((n) => n === 0)).toBe(true);

    const prefs = await prisma.userNotificationPrefs.findMany();
    const idFor = (e: string) => prefs.find((p) => p.userEmail === e)?.memberId;
    expect(idFor("carol.old@acme.com")).toBe(carolId);
    expect(idFor("alice@acme.com")).toBe(carolId);
    // overrides are keyed on the normalized email, so the variant follows
    expect(idFor("Alice@Acme.com ")).toBe(carolId);
    expect(again.unmapped.map((u) => u.email)).toEqual(["gone@old.com"]);
  });

  it("rejects an override naming an unknown member id", async () => {
    await expect(
      runMemberIdBackfill(prisma, {
        dryRun: true,
        overrides: new Map([["x@y.z", "nope"]]),
      }),
    ).rejects.toThrow(/unknown member id/);
  });
});
