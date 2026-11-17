import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildGitHubAuthDeps } from "./github-auth-deps.ts";
import { SCRIPTS_BIN } from "./scripts-bin.ts";

describe("SCRIPTS_BIN", () => {
  test("resolves to <repoRoot>/scripts/bin", () => {
    expect(SCRIPTS_BIN).toBe(resolve(import.meta.dir, "..", "scripts", "bin"));
  });

  test("contains the git credential helper", () => {
    expect(existsSync(join(SCRIPTS_BIN, "git-credential-shipwright.sh"))).toBe(
      true,
    );
  });

  test("buildGitHubAuthDeps credentialHelperPath exists on disk", () => {
    const deps = buildGitHubAuthDeps("/tmp/agent-home", SCRIPTS_BIN);
    expect(existsSync(deps.credentialHelperPath)).toBe(true);
  });
});
