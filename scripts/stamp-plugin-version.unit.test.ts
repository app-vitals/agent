import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampPluginVersion } from "./stamp-plugin-version.ts";

function fixture(): string {
  const path = join(mkdtempSync(join(tmpdir(), "stamp-")), "plugin.json");
  writeFileSync(
    path,
    `${JSON.stringify({ name: "agent-platform", version: "0.3.0", keywords: ["a"] }, null, 2)}\n`,
  );
  return path;
}

describe("stampPluginVersion", () => {
  test("writes the version and leaves other fields intact", () => {
    const path = fixture();
    stampPluginVersion("1.4.2", path);
    const out = JSON.parse(readFileSync(path, "utf8"));
    expect(out).toEqual({
      name: "agent-platform",
      version: "1.4.2",
      keywords: ["a"],
    });
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
  });

  test("rejects non X.Y.Z versions without touching the file", () => {
    const path = fixture();
    const before = readFileSync(path, "utf8");
    for (const bad of ["v1.2.3", "1.2", "1.2.3-rc.1", ""]) {
      expect(() => stampPluginVersion(bad, path)).toThrow("X.Y.Z");
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("defaults to the checked-in plugin.json path", () => {
    const real = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../plugins/agent-platform/.claude-plugin/plugin.json"),
        "utf8",
      ),
    );
    expect(real.name).toBe("agent-platform");
  });
});
