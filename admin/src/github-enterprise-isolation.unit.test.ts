/**
 * admin/src/github-enterprise-isolation.unit.test.ts
 * Isolation exception guard (GHE-1.3): the GitHub Enterprise App private key
 * is reachable only from the enterprise service, its admin API and the boot
 * wiring. Agent config bundle, agent-bearer routes and env serialization must
 * never import the service, touch its table or call getPrivateKey().
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;

/** Non-test source files that may reference the key-bearing service/table. */
const ALLOWED = new Set([
  "admin/src/github-enterprise-apps.ts",
  "admin/src/github-enterprise-api.ts",
  "admin/src/admin-boot.ts",
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "client" || name.startsWith(".")) {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.(unit|integration|smoke|fixtures)\.test\.ts$|\.test\.ts$|\.fixtures\.ts$/.test(
        name,
      )
    ) {
      out.push(p);
    }
  }
  return out;
}

describe("GitHub Enterprise key isolation", () => {
  const files = ["admin/src", "runtime", "lib", "chat", "index.ts"].flatMap(
    (d) => {
      const p = join(REPO, d);
      return statSync(p).isDirectory() ? sources(p) : [p];
    },
  );

  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("only the allowlisted modules touch the key-bearing service or table", () => {
    const offenders = files
      .map((f) => relative(REPO, f))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        const src = readFileSync(join(REPO, rel), "utf-8");
        return (
          /github-enterprise-apps/.test(src) ||
          /gitHubEnterpriseApp\b/.test(src) ||
          /GitHubEnterpriseApp\b/.test(src) ||
          /privateKeyEncrypted/.test(src)
        );
      });
    expect(offenders).toEqual([]);
  });

  it("getPrivateKey() is only called by the enterprise API", () => {
    const callers = files
      .map((f) => relative(REPO, f))
      .filter((rel) =>
        /\.getPrivateKey\(/.test(readFileSync(join(REPO, rel), "utf-8")),
      );
    expect(callers).toEqual(["admin/src/github-enterprise-api.ts"]);
  });

  it("the config bundle and env serializers never read the enterprise table", () => {
    for (const rel of ["admin/src/agent-envs.ts", "admin/src/api.ts"]) {
      const src = readFileSync(join(REPO, rel), "utf-8");
      expect(src).not.toMatch(/enterprise/i);
    }
  });

  it("the upload route and parser never touch the key-bearing service", () => {
    for (const rel of [
      "admin/src/admin-ui-github-enterprise.ts",
      "admin/src/github-enterprise-pem-upload.ts",
    ]) {
      const src = readFileSync(join(REPO, rel), "utf-8");
      expect(src).not.toMatch(/\.getPrivateKey\(|privateKeyEncrypted/);
      expect(src).not.toMatch(/github-enterprise-apps/);
      // Uploaded content is never logged.
      expect(src).not.toMatch(/console\.|logger\./);
    }
  });

  it("the upload field name is only handled by the pem-upload parser", () => {
    const handlers = files
      .map((f) => relative(REPO, f))
      .filter((rel) =>
        /get\(["']privateKeyFile["']\)/.test(
          readFileSync(join(REPO, rel), "utf-8"),
        ),
      );
    expect(handlers).toEqual(["admin/src/github-enterprise-pem-upload.ts"]);
  });
});
