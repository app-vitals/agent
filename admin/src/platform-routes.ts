/**
 * admin/src/platform-routes.ts
 * The single place the platform admin APIs are mounted on a root app.
 *
 * startAdmin (admin-boot.ts) calls mountPlatformApis with real services and
 * buildPlatformAdminSpec (admin-spec.ts) calls it with stub deps, deriving the
 * OpenAPI document from the returned `mounted` list. Adding a platform sub-app
 * therefore means touching this file only.
 *
 * Mount order is part of the contract: every platform API is mounted here,
 * before extension routes and the admin UI (/admin/*), which startAdmin mounts
 * after this call so nothing shadows them.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono, MiddlewareHandler } from "hono";
import { createAccountsApp } from "./accounts-api.ts";
import { createAgentTemplatesApp } from "./agent-templates-api.ts";
import { type AdminDeps, createAdminApp } from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { createGithubEnterpriseApp } from "./github-enterprise-api.ts";
import { mountPlatformDoc } from "./platform-doc-route.ts";
import { createPrincipalsApp } from "./principals-api.ts";

type AgentRuntimeDeps = Parameters<typeof createAgentRuntimeApp>[0];
type AccountsDeps = Parameters<typeof createAccountsApp>[0];
type PrincipalsDeps = Parameters<typeof createPrincipalsApp>[0];
type TemplatesDeps = Parameters<typeof createAgentTemplatesApp>[0];
type GithubEnterpriseDeps = Parameters<typeof createGithubEnterpriseApp>[0];

export interface PlatformApiDeps {
  runtime: AgentRuntimeDeps;
  adminApi: AdminDeps;
  /** Flag-gated GET /doc; omitted when no doc route should be mounted. */
  doc?: {
    env: Record<string, string | undefined>;
    auth: MiddlewareHandler;
  };
  accounts: AccountsDeps;
  principals: PrincipalsDeps;
  templates: TemplatesDeps;
  githubEnterprise: GithubEnterpriseDeps;
}

export interface MountedPlatformApp {
  name: string;
  /** Path prefix the app is mounted under on the root. */
  prefix: string;
  // biome-ignore lint/suspicious/noExplicitAny: apps carry differing Env generics
  app: OpenAPIHono<any>;
  /**
   * Whether the app's routes belong in the committed platform spec
   * (admin/openapi.platform.json). `false` only for apps deliberately kept out
   * of it; each such app must say why in `specExclusion`.
   */
  inSpec: boolean;
  specExclusion?: string;
}

export interface MountedPlatformApis {
  /** Every mounted platform app, in mount order. */
  mounted: MountedPlatformApp[];
  // biome-ignore lint/suspicious/noExplicitAny: see MountedPlatformApp.app
  adminApiApp: OpenAPIHono<any>;
  // biome-ignore lint/suspicious/noExplicitAny: see MountedPlatformApp.app
  githubEnterpriseApp: OpenAPIHono<any>;
  templateService: TemplatesDeps["templateService"];
}

/** Mounts every platform admin API on `root`, in the order the boot relies on. */
export function mountPlatformApis(
  // biome-ignore lint/suspicious/noExplicitAny: the root app carries arbitrary Env generics
  root: Hono<any>,
  deps: PlatformApiDeps,
): MountedPlatformApis {
  const mounted: MountedPlatformApp[] = [];
  const mount = (entry: MountedPlatformApp) => {
    root.route(entry.prefix, entry.app);
    mounted.push(entry);
  };

  // Runtime API — admin key | per-agent bearer | session JWT. Hono strips the
  // /agents prefix before dispatching, so its routes are /:id/config etc.
  mount({
    name: "runtime",
    prefix: "/agents",
    app: createAgentRuntimeApp(deps.runtime),
    inSpec: true,
  });

  // Admin CRUD API — /agents/:id/* (same prefix as runtime, different sub-paths).
  const adminApiApp = createAdminApp(deps.adminApi);
  mount({ name: "admin", prefix: "/", app: adminApiApp, inSpec: true });

  // Platform OpenAPI document — GET /doc, flag-gated (not mounted when off).
  if (deps.doc) mountPlatformDoc(root, deps.doc);

  mount({
    name: "accounts",
    prefix: "/",
    app: createAccountsApp(deps.accounts),
    inSpec: false,
    specExclusion:
      "flag-gated (self-serve signup); never part of the committed platform spec",
  });
  // The three apps below own disjoint prefixes, so their relative order does
  // not affect routing; it is fixed to keep the committed spec's key order.
  const githubEnterpriseApp = createGithubEnterpriseApp(deps.githubEnterprise);
  mount({
    name: "github-enterprise",
    prefix: "/",
    app: githubEnterpriseApp,
    inSpec: true,
  });
  mount({
    name: "templates",
    prefix: "/",
    app: createAgentTemplatesApp(deps.templates),
    inSpec: true,
  });
  mount({
    name: "principals",
    prefix: "/",
    app: createPrincipalsApp(deps.principals),
    inSpec: true,
  });

  return {
    mounted,
    adminApiApp,
    githubEnterpriseApp,
    templateService: deps.templates.templateService,
  };
}
