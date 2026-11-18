import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCredentialHelper } from "./setup-github-auth.ts";

describe("checkCredentialHelper", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cred-helper-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("ok for an executable file", () => {
    const p = join(dir, "helper.sh");
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    expect(checkCredentialHelper(p)).toEqual({ ok: true });
  });

  test("fails for a missing path", () => {
    expect(checkCredentialHelper(join(dir, "nope"))).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("fails for a non-executable file", () => {
    const p = join(dir, "helper.sh");
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o644);
    const r = checkCredentialHelper(p);
    expect(r.ok).toBe(false);
  });

  test("fails for a directory", () => {
    expect(checkCredentialHelper(dir).ok).toBe(false);
  });
});
