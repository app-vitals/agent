/**
 * admin/src/admin-spec.ts
 * Builds the platform-only OpenAPI 3.1 document of the admin service.
 *
 * Instantiates the admin CRUD app and the agent runtime app in-process with
 * minimal stubs (no real DB, no real services — only route definitions matter),
 * then:
 *   1. Calls getOpenAPI31Document() on each sub-app independently.
 *   2. Rewrites the runtime app's Hono-style path params (`:id`) to OpenAPI
 *      style (`{id}`) and prefixes them with `/agents`.
 *   3. Merges both specs' paths and component schemas into a single document.
 *
 * The result is committed as admin/openapi.platform.json and feeds the
 * platform half of the generated admin types (lib/admin-types.ts). Consumers
 * that compose admin extensions fold the extensions' OpenAPI contributions in
 * on top (applyOpenApiContributions) — Shipwright does so in
 * scripts/generate-admin-spec.ts to produce the composed admin/openapi.json.
 */

import { Hono } from "hono";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { type AdminDeps, parseAdminApiKeys } from "./agents-api.ts";
import { mountPlatformApis } from "./platform-routes.ts";

/** The admin OpenAPI document shape the spec builders and generators share. */
export interface AdminOpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

/** Builds the platform-only admin OpenAPI document (no extension routes). */
export function buildPlatformAdminSpec(): AdminOpenApiDocument {
  // Stub deps — only route definitions matter for spec generation.
  const SESSION_SECRET = "dummy-secret-32chars-for-spec-gen";
  const adminApiKeys = parseAdminApiKeys("codegen:codegen-key:*");

  const { mounted } = mountPlatformApis(new Hono(), {
    runtime: {
      agentEnvService: {
        async getConfigBundle() {
          return null;
        },
      },
      agentCronJobService: {
        async list() {
          return [];
        },
      },
      agentService: {
        async getById() {
          return null;
        },
      },
      agentPluginService: {
        async listEnabled() {
          return [];
        },
      },
      adminApiKeys,
      agentTokenService: { validate: async () => null },
      sessionSecret: SESSION_SECRET,
    },
    adminApi: {
      agentEnvService: {
        upsert: async () => {},
        patch: async () => {},
        getByAgentId: async () => null,
        deleteKey: async () => {},
      },
      agentCronJobService: {
        list: async () => [],
        listWithRunSummary: async () => [],
        create: async () => ({}) as never,
        update: async () => ({}) as never,
        delete: async () => {},
        get: async () => ({}) as never,
        setEnabled: async () => ({}) as never,
        updatePreCheck: async () => ({}) as never,
        reconcileSystemCrons: async () => ({
          created: 0,
          updated: 0,
          deleted: 0,
        }),
      },
      agentToolService: {
        list: async () => [],
        add: async () => ({}) as never,
        remove: async () => {},
        toggle: async () => ({}) as never,
      },
      agentTokenService: {
        create: async () => ({}) as never,
        listForAgent: async () => [],
        revoke: async () => ({}) as never,
        validate: async () => null,
      },
      agentPluginService: {
        list: async () => [],
        add: async () => ({}) as never,
        remove: async () => {},
        removeByName: async () => {},
      },
      prisma: {
        agent: {
          create: async () => ({}) as never,
          findUnique: async () => null,
          findMany: async () => [],
          delete: async () => ({}) as never,
        },
      } as never,
      provisioner: new NoopAgentProvisioner(),
      sessionSecret: SESSION_SECRET,
      adminApiKeys,
      // Partial on purpose: route registration never calls the services, so
      // only the deps a factory reads at construction time are stubbed.
    } as unknown as AdminDeps,
    accounts: {
      accountService: {} as never,
      accountLifecycle: {} as never,
      sessionSecret: SESSION_SECRET,
      adminApiKeys,
      agentTokenService: { validate: async () => null },
    },
    principals: {
      lookup: {} as never,
      sessionSecret: SESSION_SECRET,
      adminApiKeys,
      agentTokenService: { validate: async () => null },
    },
    templates: {
      templateService: {} as never,
      callerScopeResolver: async () => ({ kind: "all" }),
      sessionSecret: SESSION_SECRET,
      adminApiKeys,
      agentTokenService: { validate: async () => null },
    },
    githubEnterprise: {
      appService: {} as never,
      agentService: {} as never,
      agentEnvService: {} as never,
      sessionSecret: SESSION_SECRET,
      adminApiKeys,
      agentTokenService: { validate: async () => null },
    },
  });

  const docInfo = {
    openapi: "3.1.0" as const,
    info: {
      title: "Shipwright Admin API",
      version: "0.1.0",
      description:
        "REST API for the Shipwright admin service — CRUD for agents, env vars, cron jobs, tokens, tools, and plugins, plus the agent runtime polling endpoints.",
    },
    servers: [{ url: "http://localhost:3457", description: "Local dev" }],
  };

  // The admin app is the base document (it carries info/servers); every other
  // spec'd app is folded in on top of it. Admin goes first so its paths lead.
  const specApps = mounted.filter((m) => m.inSpec);
  const adminEntry = specApps.find((m) => m.name === "admin");
  if (!adminEntry) throw new Error("platform admin app is not mounted");
  const adminSpec = adminEntry.app.getOpenAPI31Document(docInfo);

  const mergedPaths: Record<string, Record<string, unknown>> = {
    ...((adminSpec.paths ?? {}) as Record<string, Record<string, unknown>>),
  };
  const schemas: Record<string, unknown> = {
    ...(adminSpec.components?.schemas ?? {}),
  };

  for (const entry of specApps) {
    if (entry === adminEntry) continue;
    const spec = entry.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: `${entry.name} (internal)`, version: "0.1.0" },
    });
    // A sub-app's paths are relative to its mount prefix and use Hono `:id`
    // params; rewrite to OpenAPI `{id}` and prefix them (runtime -> /agents).
    // Merge at the method level so paths shared between apps (e.g.
    // /agents/{id}/crons: admin POST + runtime GET) keep all their methods.
    const prefix = entry.prefix === "/" ? "" : entry.prefix;
    for (const [path, def] of Object.entries(spec.paths ?? {})) {
      const openApiPath = `${prefix}${path.replace(/:(\w+)/g, "{$1}")}`;
      mergedPaths[openApiPath] = {
        ...mergedPaths[openApiPath],
        ...(def as Record<string, unknown>),
      };
    }
    Object.assign(schemas, spec.components?.schemas ?? {});
  }

  return {
    ...adminSpec,
    paths: mergedPaths,
    components: {
      ...(adminSpec.components ?? {}),
      schemas,
    },
  };
}
