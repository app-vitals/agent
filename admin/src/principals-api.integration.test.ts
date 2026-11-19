/**
 * admin/src/principals-api.integration.test.ts
 * /principals lookups against real Postgres (ACM-1.1), plus the additive
 * nullable memberId columns from 20261118000000_add_member_id_columns.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { PrincipalLookupService } from "./principal-lookup.ts";
import { createPrincipalsApp } from "./principals-api.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("/principals API (integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createPrincipalsApp>;
  const headers = {
    Authorization: "Bearer k",
    "Content-Type": "application/json",
  };

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentMember.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.account.deleteMany();
    app = createPrincipalsApp({
      lookup: new PrincipalLookupService(prisma),
      sessionSecret: "s".repeat(32),
      adminApiKeys: new Map([["k", { name: "t", scope: "*" }]]),
      agentTokenService: { validate: async () => null } as never,
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("batch resolves mixed member/agent ids and reports unknown ids as notFound", async () => {
    const account = await prisma.account.create({ data: { name: "Acme" } });
    const member = await prisma.accountMember.create({
      data: { accountId: account.id, email: "owner@acme.com", role: "owner" },
    });
    const agent = await prisma.agent.create({ data: { name: "bot" } });

    const res = await app.request("/principals/lookup", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [member.id, agent.id, "missing"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principals: [
        { id: member.id, type: "user", email: "owner@acme.com" },
        { id: agent.id, type: "agent", email: null },
      ],
      notFound: ["missing"],
    });
  });

  it("email -> id is case-insensitive", async () => {
    const account = await prisma.account.create({ data: { name: "Acme" } });
    const member = await prisma.accountMember.create({
      data: { accountId: account.id, email: "owner@acme.com", role: "owner" },
    });
    const res = await app.request("/principals/by-email?email=Owner@ACME.com", {
      headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: member.id,
      type: "user",
      email: "owner@acme.com",
    });
    const miss = await app.request(
      "/principals/by-email?email=nobody@acme.com",
      { headers },
    );
    expect(miss.status).toBe(404);
  });

  it("memberId columns exist, are nullable and default to NULL", async () => {
    const cols = await prisma.$queryRaw<
      {
        table_name: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`SELECT table_name, is_nullable, column_default FROM information_schema.columns
      WHERE column_name = 'memberId'
        AND table_name IN ('UserNotificationPrefs','ChatThreadWatch','PushSubscription','AgentMember')
      ORDER BY table_name`;
    expect(cols.map((c) => c.table_name)).toEqual([
      "AgentMember",
      "ChatThreadWatch",
      "PushSubscription",
      "UserNotificationPrefs",
    ]);
    for (const c of cols) {
      expect(c.is_nullable).toBe("YES");
      expect(c.column_default).toBeNull();
    }
    const fks = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
      WHERE ccu.column_name = 'memberId'
        AND tc.table_name IN ('UserNotificationPrefs','ChatThreadWatch','PushSubscription','AgentMember')`;
    expect(Number(fks[0]?.n)).toBe(0);
  });
});
