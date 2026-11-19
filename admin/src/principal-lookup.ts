/**
 * admin/src/principal-lookup.ts
 * PrincipalLookupService (ACM-1.1): a principal is an AccountMember.id (type
 * "user") or an Agent.id (type "agent"). Resolves principal ids to
 * {type,email} in batch and a (case-insensitive) email to its principal.
 *
 * Agents have no email of their own, so they resolve with email: null, and an
 * email only ever resolves to a user principal.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { normalizeEmail } from "./account-email.ts";

export interface Principal {
  id: string;
  type: "user" | "agent";
  email: string | null;
}

export interface PrincipalLookupResult {
  principals: Principal[];
  notFound: string[];
}

export class PrincipalLookupService {
  constructor(private prisma: PrismaClient) {}

  /** Unknown ids land in `notFound`; results follow first-seen request order. */
  async resolveMany(ids: string[]): Promise<PrincipalLookupResult> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { principals: [], notFound: [] };

    const [members, agents] = await Promise.all([
      this.prisma.accountMember.findMany({
        where: { id: { in: unique } },
        select: { id: true, email: true },
      }),
      this.prisma.agent.findMany({
        where: { id: { in: unique } },
        select: { id: true },
      }),
    ]);
    const byId = new Map<string, Principal>();
    for (const a of agents)
      byId.set(a.id, { id: a.id, type: "agent", email: null });
    // Ids are cuids so collisions are not expected; a member wins if one occurs.
    for (const m of members)
      byId.set(m.id, { id: m.id, type: "user", email: m.email });

    const principals: Principal[] = [];
    const notFound: string[] = [];
    for (const id of unique) {
      const p = byId.get(id);
      if (p) principals.push(p);
      else notFound.push(id);
    }
    return { principals, notFound };
  }

  async findIdByEmail(email: string): Promise<Principal | null> {
    const member = await this.prisma.accountMember.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true, email: true },
    });
    return member ? { id: member.id, type: "user", email: member.email } : null;
  }
}
