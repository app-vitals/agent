import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkCodingBoundary,
  formatAllowlist,
  parseAllowlist,
  scanCodingLeaks,
} from "./check-coding-boundary";

let root: string;

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coding-boundary-"));
  write("lib/util.ts", "export const util = 1;\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scanCodingLeaks", () => {
  it("finds nothing in a clean tree", () => {
    expect(scanCodingLeaks(root)).toEqual([]);
  });

  it("counts coding-owned module imports, literals and DEFAULT_PLUGINS", () => {
    write(
      "runtime/boot.ts",
      [
        'import { x } from "@app-vitals/agent-lib/claim-ttl";',
        'const type = "coding";',
        'const DEFAULT_PLUGINS = ["shipwright"];',
        "use(DEFAULT_PLUGINS);",
      ].join("\n"),
    );
    expect(scanCodingLeaks(root)).toEqual([
      { rule: "coding-module", file: "runtime/boot.ts", count: 1 },
      { rule: "coding-literal", file: "runtime/boot.ts", count: 1 },
      { rule: "default-plugins", file: "runtime/boot.ts", count: 2 },
    ]);
  });

  it("flags a coding-owned module file living in a platform dir", () => {
    write("lib/default-account.ts", "export const a = 1;\n");
    expect(scanCodingLeaks(root)).toEqual([
      { rule: "coding-module", file: "lib/default-account.ts", count: 1 },
    ]);
  });

  it("ignores comments, tests, fixtures and unscanned dirs", () => {
    write("admin/src/a.ts", '// the "coding" agent\n/* "coding" */\n');
    write("admin/src/a.unit.test.ts", 'const t = "coding";\n');
    write("admin/src/a.fixtures.ts", 'const t = "coding";\n');
    write("scripts/tool.ts", 'const t = "coding";\n');
    expect(scanCodingLeaks(root)).toEqual([]);
  });
});

describe("checkCodingBoundary", () => {
  it("fails on a new leak outside the allowlist", () => {
    write("admin/src/new.ts", 'export const t = "coding";\n');
    expect(checkCodingBoundary(root, [])).toEqual({
      newLeaks: [{ rule: "coding-literal", file: "admin/src/new.ts", count: 1 }],
      staleEntries: [],
    });
  });

  it("fails when an allowlisted file gains another leak", () => {
    write("admin/src/old.ts", 'const a = "coding";\nconst b = "coding";\n');
    const allow = [{ rule: "coding-literal", file: "admin/src/old.ts", count: 1 }];
    expect(checkCodingBoundary(root, allow).newLeaks).toHaveLength(1);
  });

  it("fails on a stale allowlist entry", () => {
    const allow = [{ rule: "coding-literal", file: "admin/src/gone.ts", count: 1 }];
    expect(checkCodingBoundary(root, allow)).toEqual({
      newLeaks: [],
      staleEntries: allow,
    });
  });

  it("fails when an entry's count is higher than the remaining leaks", () => {
    write("admin/src/old.ts", 'const a = "coding";\n');
    const allow = [{ rule: "coding-literal", file: "admin/src/old.ts", count: 2 }];
    expect(checkCodingBoundary(root, allow).staleEntries).toEqual(allow);
  });

  it("passes an exactly allowlisted leak", () => {
    write("admin/src/old.ts", 'const a = "coding";\n');
    const allow = [{ rule: "coding-literal", file: "admin/src/old.ts", count: 1 }];
    expect(checkCodingBoundary(root, allow)).toEqual({
      newLeaks: [],
      staleEntries: [],
    });
  });
});

describe("allowlist format", () => {
  it("round-trips and skips comments and blank lines", () => {
    const text = "# header\n\ncoding-literal a/b.ts 2 # why\n";
    const parsed = parseAllowlist(text);
    expect(parsed).toEqual([{ rule: "coding-literal", file: "a/b.ts", count: 2 }]);
    expect(parseAllowlist(formatAllowlist(parsed))).toEqual(parsed);
  });

  it("rejects malformed lines", () => {
    expect(() => parseAllowlist("coding-literal a/b.ts")).toThrow("malformed");
  });
});
