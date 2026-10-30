/**
 * admin/src/agent-specialty-backfill.integration.test.ts
 * Migration-ordering test for the typeName -> specialty rename
 * (AGR-6.1 ADD, AGR-6.3 REMOVE).
 *
 * After AGR-6.3 the live test database no longer has an "Agent"."typeName"
 * column, so this test cannot seed the pre-drop state through Prisma. Instead
 * it replays the real migration files, in order, against a skeleton "Agent"
 * table inside a throwaway Postgres schema:
 *
 *   20260724000000_add_agent_type_name   adds typeName NOT NULL DEFAULT 'coding'
 *   20261029000000_add_agent_specialty   adds nullable specialty + backfill
 *   20261030000000_drop_agent_type_name  backfills stragglers, specialty NOT NULL,
 *                                        drops typeName
 *
 * Seeded from the live distinct values (admin API, 2026-10-27): coding
 * (11 agents) and specialist (1 agent). A row written between the AGR-6.1
 * backfill and the AGR-6.3 migration (specialty still NULL) must be
 * backfilled from typeName by the drop migration.
 *
 * Requires DATABASE_URL_ADMIN_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const LIVE_SPECIALTIES = ["coding", "specialist"] as const;

function migrationSql(dir: string): string {
  return readFileSync(
    new URL(`../prisma/migrations/${dir}/migration.sql`, import.meta.url),
    "utf8",
  );
}

const ADD_TYPE_NAME = migrationSql("20260724000000_add_agent_type_name");
const ADD_SPECIALTY = migrationSql("20261029000000_add_agent_specialty");
const DROP_TYPE_NAME = migrationSql("20261030000000_drop_agent_type_name");
const SET_DEFAULT_SPECIALIST = migrationSql(
  "20261030100000_set_agent_specialty_default_specialist",
);

describeOrSkip("typeName -> specialty migrations (AGR-6.1 / AGR-6.3)", () => {
  const schema = `agr63_${process.pid}_${Date.now()}`;
  let client: Client;

  const columns = async (): Promise<string[]> =>
    (
      await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'Agent'`,
        [schema],
      )
    ).rows.map((r) => r.column_name);

  beforeEach(async () => {
    client = new Client({ connectionString: TEST_DB as string });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      `CREATE TABLE "Agent" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL)`,
    );
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("add_agent_specialty backfills specialty from typeName and leaves it nullable", async () => {
    await client.query(ADD_TYPE_NAME);
    for (const [i, s] of LIVE_SPECIALTIES.entries()) {
      await client.query(
        `INSERT INTO "Agent" ("id","name","typeName") VALUES ($1,$2,$3)`,
        [`a${i}`, `agent-${i}`, s],
      );
    }
    await client.query(ADD_SPECIALTY);

    const { rows } = await client.query<{ specialty: string | null }>(
      `SELECT "specialty" FROM "Agent" ORDER BY "id"`,
    );
    expect(rows.map((r) => r.specialty)).toEqual([...LIVE_SPECIALTIES]);
  });

  it("drop_agent_type_name backfills NULL specialty, makes it required and drops typeName", async () => {
    await client.query(ADD_TYPE_NAME);
    await client.query(ADD_SPECIALTY);
    // Rows written after the AGR-6.1 backfill: one with specialty set, one
    // straggler with specialty NULL and a non-default typeName.
    await client.query(
      `INSERT INTO "Agent" ("id","name","typeName","specialty")
       VALUES ('a0','agent-0','coding','coding')`,
    );
    await client.query(
      `INSERT INTO "Agent" ("id","name","typeName") VALUES ('a1','agent-1','specialist')`,
    );

    await client.query(DROP_TYPE_NAME);

    expect(await columns()).not.toContain("typeName");
    const { rows } = await client.query<{ id: string; specialty: string }>(
      `SELECT "id","specialty" FROM "Agent" ORDER BY "id"`,
    );
    expect(rows).toEqual([
      { id: "a0", specialty: "coding" },
      { id: "a1", specialty: "specialist" },
    ]);

    // specialty is now NOT NULL with a 'coding' default.
    await expect(
      client.query(
        `INSERT INTO "Agent" ("id","name","specialty") VALUES ('a2','agent-2',NULL)`,
      ),
    ).rejects.toThrow();
    await client.query(
      `INSERT INTO "Agent" ("id","name") VALUES ('a3','agent-3')`,
    );
    const def = await client.query<{ specialty: string }>(
      `SELECT "specialty" FROM "Agent" WHERE "id" = 'a3'`,
    );
    expect(def.rows[0]?.specialty).toBe("coding");
  });

  it("set_agent_specialty_default_specialist changes only the default and leaves rows unchanged (PCD-3.4)", async () => {
    await client.query(ADD_TYPE_NAME);
    await client.query(ADD_SPECIALTY);
    await client.query(DROP_TYPE_NAME);
    for (const [i, s] of LIVE_SPECIALTIES.entries()) {
      await client.query(
        `INSERT INTO "Agent" ("id","name","specialty") VALUES ($1,$2,$3)`,
        [`a${i}`, `agent-${i}`, s],
      );
    }

    await client.query(SET_DEFAULT_SPECIALIST);

    const { rows } = await client.query<{ specialty: string }>(
      `SELECT "specialty" FROM "Agent" ORDER BY "id"`,
    );
    expect(rows.map((r) => r.specialty)).toEqual([...LIVE_SPECIALTIES]);

    await client.query(
      `INSERT INTO "Agent" ("id","name") VALUES ('a9','agent-9')`,
    );
    const def = await client.query<{ specialty: string }>(
      `SELECT "specialty" FROM "Agent" WHERE "id" = 'a9'`,
    );
    expect(def.rows[0]?.specialty).toBe("specialist");
  });
});
