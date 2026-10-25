/**
 * scripts/cli-scripts.unit.test.ts
 *
 * Argument-handling and smoke tests for the operator CLI scripts that run on
 * import or with arguments via Bun CLI. Every case exits before any network or
 * DB use.
 */

import { describe, expect, test } from "bun:test";

const SCRIPTS = import.meta.dir;

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", `${SCRIPTS}/${script}`, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("verify-cgroup-delegation.ts smoke test", () => {
  test("runs without throwing and exits with code 0", () => {
    const r = run("verify-cgroup-delegation.ts", []);
    expect(r.code).toBe(0);
    // Should produce output showing cgroup probe results
    expect(r.out).toContain("cgroup mount root:");
    expect(r.out).toContain("resolved cgroup base:");
    expect(r.out).toContain("probe:");
    expect(r.out).toContain("Process-tree kill mode:");
  });

  test("reports either CGROUP or PROCFS FALLBACK mode", () => {
    const r = run("verify-cgroup-delegation.ts", []);
    expect(r.code).toBe(0);
    const isCgroup = r.out.includes("Process-tree kill mode: CGROUP");
    const isFallback = r.out.includes(
      "Process-tree kill mode: PROCFS FALLBACK",
    );
    expect(isCgroup || isFallback).toBe(true);
  });
});
