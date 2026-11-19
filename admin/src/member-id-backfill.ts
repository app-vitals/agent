/**
 * admin/src/member-id-backfill.ts
 * ACM-1.2: maps the email-keyed per-user rows (UserNotificationPrefs,
 * ChatThreadWatch, PushSubscription, AgentMember) to AccountMember.id.
 *
 * - Match order: overrides (email -> member id) first, then the automatic
 *   match on the normalized email against AccountMember.email.
 * - Dry run writes nothing and reports every distinct email with no match,
 *   with its row count per table.
 * - Apply sets memberId on matched rows (only where it differs from the
 *   target, so a re-run is a no-op) and leaves unmapped rows null.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { normalizeEmail } from "./account-email.ts";

export const BACKFILL_TABLES = [
  "UserNotificationPrefs",
  "ChatThreadWatch",
  "PushSubscription",
  "AgentMember",
] as const;
export type BackfillTable = (typeof BACKFILL_TABLES)[number];

export interface UnmappedEmail {
  email: string;
  /** Row counts per table (only tables with at least one such row). */
  counts: Partial<Record<BackfillTable, number>>;
}

export interface MemberIdBackfillReport {
  dryRun: boolean;
  /** Rows set (apply) or that would be set (dry run), per table. */
  mapped: Record<BackfillTable, number>;
  unmapped: UnmappedEmail[];
}

/** Parses an overrides file body: a JSON object of email -> AccountMember.id. */
export function parseOverrides(json: string): Map<string, string> {
  const raw: unknown = JSON.parse(json);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("overrides must be a JSON object of email -> member id");
  }
  const out = new Map<string, string>();
  for (const [email, id] of Object.entries(raw)) {
    if (typeof id !== "string" || id === "") {
      throw new Error(`override for ${email} must be a non-empty member id`);
    }
    out.set(normalizeEmail(email), id);
  }
  return out;
}

interface TableAccess {
  distinct(): Promise<{ email: string; count: number }[]>;
  /** Sets memberId on rows keyed by this exact email value that don't already have it. */
  assign(email: string, memberId: string): Promise<number>;
}

function tableAccess(prisma: PrismaClient): Record<BackfillTable, TableAccess> {
  const notId = (memberId: string) => ({
    OR: [{ memberId: null }, { memberId: { not: memberId } }],
  });
  return {
    UserNotificationPrefs: {
      distinct: async () =>
        (
          await prisma.userNotificationPrefs.groupBy({
            by: ["userEmail"],
            _count: { _all: true },
          })
        ).map((g) => ({ email: g.userEmail, count: g._count._all })),
      assign: async (email, memberId) =>
        (
          await prisma.userNotificationPrefs.updateMany({
            where: { userEmail: email, ...notId(memberId) },
            data: { memberId },
          })
        ).count,
    },
    ChatThreadWatch: {
      distinct: async () =>
        (
          await prisma.chatThreadWatch.groupBy({
            by: ["userEmail"],
            _count: { _all: true },
          })
        ).map((g) => ({ email: g.userEmail, count: g._count._all })),
      assign: async (email, memberId) =>
        (
          await prisma.chatThreadWatch.updateMany({
            where: { userEmail: email, ...notId(memberId) },
            data: { memberId },
          })
        ).count,
    },
    PushSubscription: {
      distinct: async () =>
        (
          await prisma.pushSubscription.groupBy({
            by: ["userEmail"],
            _count: { _all: true },
          })
        ).map((g) => ({ email: g.userEmail, count: g._count._all })),
      assign: async (email, memberId) =>
        (
          await prisma.pushSubscription.updateMany({
            where: { userEmail: email, ...notId(memberId) },
            data: { memberId },
          })
        ).count,
    },
    AgentMember: {
      distinct: async () =>
        (
          await prisma.agentMember.groupBy({
            by: ["email"],
            _count: { _all: true },
          })
        ).map((g) => ({ email: g.email, count: g._count._all })),
      assign: async (email, memberId) =>
        (
          await prisma.agentMember.updateMany({
            where: { email, ...notId(memberId) },
            data: { memberId },
          })
        ).count,
    },
  };
}

export async function runMemberIdBackfill(
  prisma: PrismaClient,
  opts: { dryRun: boolean; overrides?: Map<string, string> },
): Promise<MemberIdBackfillReport> {
  const overrides = opts.overrides ?? new Map<string, string>();

  const members = await prisma.accountMember.findMany({
    select: { id: true, email: true },
  });
  const byEmail = new Map(members.map((m) => [normalizeEmail(m.email), m.id]));
  const memberIds = new Set(members.map((m) => m.id));
  for (const [email, id] of overrides) {
    if (!memberIds.has(id)) {
      throw new Error(`override for ${email} names unknown member id ${id}`);
    }
  }

  const tables = tableAccess(prisma);
  const mapped = Object.fromEntries(
    BACKFILL_TABLES.map((t) => [t, 0]),
  ) as Record<BackfillTable, number>;
  const unmapped = new Map<string, UnmappedEmail>();

  for (const table of BACKFILL_TABLES) {
    for (const { email, count } of await tables[table].distinct()) {
      const key = normalizeEmail(email);
      const memberId = overrides.get(key) ?? byEmail.get(key);
      if (!memberId) {
        const entry = unmapped.get(key) ?? { email: key, counts: {} };
        entry.counts[table] = (entry.counts[table] ?? 0) + count;
        unmapped.set(key, entry);
        continue;
      }
      if (opts.dryRun) {
        mapped[table] += count;
      } else {
        mapped[table] += await tables[table].assign(email, memberId);
      }
    }
  }

  return {
    dryRun: opts.dryRun,
    mapped,
    unmapped: [...unmapped.values()].sort((a, b) =>
      a.email.localeCompare(b.email),
    ),
  };
}
