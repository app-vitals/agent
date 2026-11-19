/**
 * admin/scripts/backfill-member-id.ts (ACM-1.2)
 *
 *   DATABASE_URL=... bun admin/scripts/backfill-member-id.ts [--dry-run] [--overrides overrides.json] [--report report.json]
 *
 * overrides.json: { "alice@old.com": "<AccountMember.id>" }. Overrides win over
 * the automatic email match. --dry-run changes nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseFlags } from "@app-vitals/agent-lib/cli-flags";
import { parseOverrides, runMemberIdBackfill } from "../src/member-id-backfill.ts";
import { createAdminPrismaClient } from "../src/prisma-client.ts";

const flags = parseFlags(process.argv.slice(2), ["--overrides", "--report"], {
  booleans: ["--dry-run"],
});
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const prisma = createAdminPrismaClient(url);
try {
  const overrides = flags["--overrides"]
    ? parseOverrides(readFileSync(flags["--overrides"], "utf8"))
    : undefined;
  const report = await runMemberIdBackfill(prisma, {
    dryRun: flags["--dry-run"],
    overrides,
  });
  const body = JSON.stringify(report, null, 2);
  if (flags["--report"]) writeFileSync(flags["--report"], `${body}\n`);
  console.log(body);
} finally {
  await prisma.$disconnect();
}
