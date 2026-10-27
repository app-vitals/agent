/**
 * agent/src/agent-specialty-backfill.integration.test.ts
 * Migration test for the AGR-6.1 Agent.specialty backfill
 * (20261029000000_add_agent_specialty: UPDATE "Agent" SET specialty = typeName).
 *
 * Seeded from the live distinct typeName values (admin API, 2026-10-27):
 * coding (11 agents) and specialist (1 agent). Must stay green until AGR-6.3
 * removes typeName.
 *
 * Requires DATABASE_URL_ADMIN_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../prisma/client/client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const LIVE_TYPE_NAMES = ["coding", "specialist"] as const;

const BACKFILL_SQL = readFileSync(
  new URL(
    "../prisma/migrations/20261029000000_add_agent_specialty/migration.sql",
    import.meta.url,
  ),
  "utf8",
)
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .find((s) => s.startsWith("UPDATE")) as string;

describeOrSkip("Agent.specialty backfill (AGR-6.1 migration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agent.deleteMany({
      where: { name: { startsWith: "agr62a-" } },
    });
  });

  afterEach(async () => {
    await prisma.agent.deleteMany({
      where: { name: { startsWith: "agr62a-" } },
    });
    await prisma.$disconnect();
  });

  it("extracts the UPDATE statement from the migration", () => {
    expect(BACKFILL_SQL).toContain('SET "specialty" = "typeName"');
  });

  it("sets specialty == typeName for every live typeName, leaving no NULLs", async () => {
    // Pre-migration state: rows exist with typeName only (specialty NULL).
    for (const [i, typeName] of LIVE_TYPE_NAMES.entries()) {
      await prisma.agent.create({
        data: { name: `agr62a-${i}-${typeName}`, typeName, specialty: null },
      });
    }

    // Scope the migration's UPDATE to the seeded rows so unrelated rows in a
    // shared test DB are untouched.
    await prisma.$executeRawUnsafe(
      `${BACKFILL_SQL} WHERE "name" LIKE 'agr62a-%'`,
    );

    const rows = await prisma.agent.findMany({
      where: { name: { startsWith: "agr62a-" } },
    });
    expect(rows.map((r) => r.typeName).sort()).toEqual([...LIVE_TYPE_NAMES]);
    for (const row of rows) {
      expect(row.specialty).not.toBeNull();
      expect(row.specialty).toBe(row.typeName);
    }
  });
});
