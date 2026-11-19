/**
 * admin/src/principal-lookup.unit.test.ts
 * PrincipalLookupService (ACM-1.1): id -> {type,email} (batch) and email -> id.
 */

import { describe, expect, it } from "bun:test";
import { PrincipalLookupService } from "./principal-lookup.ts";

function fakePrisma(
  members: { id: string; email: string }[],
  agents: { id: string }[],
) {
  const calls = { member: 0, agent: 0 };
  const prisma = {
    accountMember: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        calls.member++;
        return members.filter((m) => where.id.in.includes(m.id));
      },
      findUnique: async ({ where }: { where: { email: string } }) =>
        members.find((m) => m.email === where.email) ?? null,
    },
    agent: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        calls.agent++;
        return agents.filter((a) => where.id.in.includes(a.id));
      },
    },
  };
  return { prisma: prisma as never, calls };
}

describe("PrincipalLookupService.resolveMany", () => {
  it("resolves a mixed list of member and agent ids", async () => {
    const { prisma } = fakePrisma(
      [{ id: "m1", email: "a@x.com" }],
      [{ id: "a1" }],
    );
    const res = await new PrincipalLookupService(prisma).resolveMany([
      "m1",
      "a1",
    ]);
    expect(res.principals).toEqual([
      { id: "m1", type: "user", email: "a@x.com" },
      { id: "a1", type: "agent", email: null },
    ]);
    expect(res.notFound).toEqual([]);
  });

  it("returns unknown ids as notFound, not an error", async () => {
    const { prisma } = fakePrisma([{ id: "m1", email: "a@x.com" }], []);
    const res = await new PrincipalLookupService(prisma).resolveMany([
      "m1",
      "nope",
    ]);
    expect(res.principals.map((p) => p.id)).toEqual(["m1"]);
    expect(res.notFound).toEqual(["nope"]);
  });

  it("dedupes ids and preserves request order", async () => {
    const { prisma } = fakePrisma(
      [
        { id: "m1", email: "a@x.com" },
        { id: "m2", email: "b@x.com" },
      ],
      [],
    );
    const res = await new PrincipalLookupService(prisma).resolveMany([
      "m2",
      "m1",
      "m2",
      "z",
      "z",
    ]);
    expect(res.principals.map((p) => p.id)).toEqual(["m2", "m1"]);
    expect(res.notFound).toEqual(["z"]);
  });

  it("makes no queries for an empty list", async () => {
    const { prisma, calls } = fakePrisma([], []);
    const res = await new PrincipalLookupService(prisma).resolveMany([]);
    expect(res).toEqual({ principals: [], notFound: [] });
    expect(calls).toEqual({ member: 0, agent: 0 });
  });
});

describe("PrincipalLookupService.findIdByEmail", () => {
  it("normalizes case and whitespace before matching", async () => {
    const { prisma } = fakePrisma([{ id: "m1", email: "a@x.com" }], []);
    const svc = new PrincipalLookupService(prisma);
    expect(await svc.findIdByEmail("  A@X.com ")).toEqual({
      id: "m1",
      type: "user",
      email: "a@x.com",
    });
  });

  it("returns null for an unknown email", async () => {
    const { prisma } = fakePrisma([], []);
    expect(
      await new PrincipalLookupService(prisma).findIdByEmail("q@x.com"),
    ).toBeNull();
  });
});
