/**
 * admin/src/platform-routes.unit.test.ts
 *
 * Guards that startAdmin and buildPlatformAdminSpec share one mount list: every
 * app mounted by mountPlatformApis must contribute its OpenAPI paths to the
 * platform spec, unless it is explicitly excluded with a reason.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { buildPlatformAdminSpec } from "./admin-spec.ts";
import { mountPlatformApis, type PlatformApiDeps } from "./platform-routes.ts";

// Capture the mounted list through the spec builder's own stub deps by
// re-running the mount with minimal deps: factories only read deps lazily.
function mountWithStubs() {
  const noAuth = { validate: async () => null };
  const common = {
    sessionSecret: "dummy-secret-32chars-for-spec-gen",
    agentTokenService: noAuth,
  };
  const deps = {
    runtime: { ...common },
    adminApi: { ...common, provisioner: undefined },
    accounts: { accountService: {}, accountLifecycle: {}, ...common },
    principals: { lookup: {}, ...common },
    templates: {
      templateService: {},
      callerScopeResolver: async () => ({ kind: "all" }),
      ...common,
    },
    githubEnterprise: {
      appService: {},
      agentService: {},
      agentEnvService: {},
      ...common,
    },
  } as unknown as PlatformApiDeps;
  const root = new Hono();
  return { root, result: mountPlatformApis(root, deps) };
}

const toOpenApiPath = (prefix: string, path: string) =>
  `${prefix === "/" ? "" : prefix}${path.replace(/:(\w+)/g, "{$1}")}`;

describe("mountPlatformApis", () => {
  const { result } = mountWithStubs();
  const spec = buildPlatformAdminSpec();

  it("mounts the expected platform apps in order", () => {
    expect(result.mounted.map((m) => m.name)).toEqual([
      "runtime",
      "admin",
      "accounts",
      "github-enterprise",
      "templates",
      "principals",
    ]);
  });

  it("returns the apps the admin UI wiring needs", () => {
    expect(result.adminApiApp).toBe(
      result.mounted.find((m) => m.name === "admin")?.app as never,
    );
    expect(result.githubEnterpriseApp).toBe(
      result.mounted.find((m) => m.name === "github-enterprise")?.app as never,
    );
  });

  it("puts every mounted app's OpenAPI paths into buildPlatformAdminSpec()", () => {
    for (const entry of result.mounted.filter((m) => m.inSpec)) {
      const paths = Object.keys(
        entry.app.getOpenAPI31Document({
          openapi: "3.1.0",
          info: { title: entry.name, version: "0.0.0" },
        }).paths ?? {},
      );
      expect(
        paths.length,
        `${entry.name} has no OpenAPI paths`,
      ).toBeGreaterThan(0);
      for (const path of paths) {
        expect(
          Object.keys(spec.paths),
          `${entry.name}: ${path} missing from the platform spec`,
        ).toContain(toOpenApiPath(entry.prefix, path));
      }
    }
  });

  it("only leaves an app out of the spec with a stated reason", () => {
    const excluded = result.mounted.filter((m) => !m.inSpec);
    expect(excluded.map((m) => m.name)).toEqual(["accounts"]);
    for (const entry of excluded) {
      expect(entry.specExclusion?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
