/**
 * admin/src/github-enterprise-api.ts
 * Admin-only /github-enterprise API (GHE-1.3): configure the two optional
 * admin-level GitHub Apps ('installer' and 'lookup'), validate them, list the
 * enterprise's installable organizations, and install an agent's App on one.
 *
 * Isolation exception: this module (with github-enterprise-apps.ts and the
 * client files) is the only admin code that calls GitHub with App credentials.
 * No route here returns key material, and nothing here is reachable from the
 * agent config bundle, an agent-bearer route or env serialization (asserted by
 * github-enterprise-isolation.*.test.ts).
 *
 * The whole feature is optional: with no rows configured, GET /apps and
 * GET /orgs report an unconfigured status and nothing else happens.
 *
 * Auth: admin key or admin session (every other caller class gets 403).
 */

import { createPrivateKey } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { AgentEnvService } from "./agent-envs.ts";
import {
  type AdminApiKey,
  type AdminAuthEnv,
  createAdminAuthMiddleware,
} from "./api-auth.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentService } from "./agents.ts";
import {
  ApiError,
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.ts";
import { fetchAuthenticatedApp, fetchPublicApp } from "./github-app-api.ts";
import {
  GithubEnterpriseClient,
  GithubEnterpriseError,
  type GithubEnterpriseErrorKind,
  type AppInstallation,
} from "./github-enterprise-client.ts";
import {
  GITHUB_ENTERPRISE_APP_ROLES,
  type GitHubEnterpriseAppMetadata,
  type GitHubEnterpriseAppRole,
  type GitHubEnterpriseAppService,
} from "./github-enterprise-apps.ts";
import { GithubLookupClient } from "./github-lookup-client.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import { ErrorSchema } from "./openapi-schemas.ts";
import { resolveValidation } from "./github-enterprise-warnings.ts";
import { UserRepoAccessResolver } from "./user-repo-access-resolver.ts";

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface GithubEnterpriseApiDeps {
  appService: Pick<
    GitHubEnterpriseAppService,
    "list" | "get" | "save" | "delete" | "getPrivateKey" | "recordValidation"
  >;
  agentService: Pick<AgentService, "getSummary">;
  agentEnvService: Pick<AgentEnvService, "getByAgentId">;
  sessionSecret: string;
  adminApiKeys?: Map<string, AdminApiKey>;
  agentTokenService: Pick<AgentTokenService, "validate">;
  /** Test seams; default to the real GitHub API. */
  fetchFn?: typeof fetch;
  apiBase?: string;
  now?: () => Date;
}

/** Permission each role's App must hold, and the levels that satisfy it. */
const REQUIRED_PERMISSION: Record<
  GitHubEnterpriseAppRole,
  { name: string; levels: readonly string[] }
> = {
  installer: {
    name: "enterprise_organization_installations",
    levels: ["write"],
  },
  lookup: { name: "metadata", levels: ["read", "write"] },
};

const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** GitHub App client ids look like Iv1.<hex> / Iv23li<alnum>; no path or query chars. */
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// ─── Schemas ──────────────────────────────────────────────────────────────────

const RoleSchema = z.enum(GITHUB_ENTERPRISE_APP_ROLES);

const RoleParamSchema = z.object({
  role: RoleSchema.openapi({
    param: { name: "role", in: "path" },
    example: "installer",
  }),
});

const OrgParamSchema = z.object({
  org: z
    .string()
    .regex(ORG_RE)
    .openapi({ param: { name: "org", in: "path" }, example: "example-org" }),
});

const AppMetadataSchema = z
  .object({
    role: z.string().openapi({ example: "installer" }),
    appId: z.string().openapi({ example: "12345" }),
    slug: z.string().openapi({ example: "example-installer" }),
    enterpriseSlug: z.string().nullable().openapi({ example: "acme" }),
    keySet: z
      .boolean()
      .openapi({
        description:
          "True when a private key is stored. The key is never returned.",
      }),
    lastValidationStatus: z.string().nullable().openapi({ example: "valid" }),
    lastValidatedAt: z.string().nullable(),
    lastValidationError: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("GithubEnterpriseApp");

const StatusSchema = z
  .object({
    configured: z.boolean(),
    installer: AppMetadataSchema.nullable(),
    lookup: AppMetadataSchema.nullable(),
  })
  .openapi("GithubEnterpriseStatus");

const PutAppBodySchema = z
  .object({
    appId: z.string().regex(/^\d+$/).openapi({ example: "12345" }),
    slug: z.string().regex(SLUG_RE).openapi({ example: "example-installer" }),
    enterpriseSlug: z
      .string()
      .regex(SLUG_RE)
      .nullish()
      .openapi({
        description: "Required for the installer role.",
        example: "acme",
      }),
    privateKey: z
      .string()
      .min(1)
      .openapi({
        description:
          "PEM private key. Write-only: encrypted at rest, never returned.",
      }),
  })
  .openapi("PutGithubEnterpriseAppBody");

const ValidateResultSchema = z
  .object({
    role: z.string(),
    ok: z.boolean(),
    status: z.enum(["valid", "missing_permission", "error"]),
    requiredPermission: z.string(),
    grantedPermissions: z.record(z.string(), z.string()),
    error: z.string().nullable(),
    warnings: z.array(z.string()).optional().openapi({
      description:
        "Advisory, non-failing notes (e.g. missing optional permissions). Never change `ok`.",
    }),
    app: AppMetadataSchema.nullable(),
  })
  .openapi("GithubEnterpriseValidateResult");

const OrgsQuerySchema = z.object({
  agentId: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "agentId", in: "query" } }),
});

const OrgsResultSchema = z
  .object({
    configured: z.boolean(),
    agentAppSlug: z.string().nullable().optional(),
    agentAppReason: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description:
          "Why the agent's App cannot be installed through the enterprise API (private App with no stored GH_APP_CLIENT_ID, or no App at all). Null when it can; present only with agentId.",
      }),
    orgs: z.array(
      z.object({
        id: z.number(),
        login: z.string(),
        lookupAppInstalled: z
          .boolean()
          .nullable()
          .openapi({ description: "Null when no lookup App is configured." }),
        agentAppInstalled: z
          .boolean()
          .nullable()
          .openapi({
            description: "Null when no agentId (or no slug) was given.",
          }),
      }),
    ),
  })
  .openapi("GithubEnterpriseOrgs");

const InstallBodySchema = z
  .object({
    agentId: z.string().min(1).openapi({ example: "agent-id" }),
    repositorySelection: z.enum(["all", "selected", "none"]).default("all"),
    repositories: z.array(z.string().min(1)).max(50).optional(),
  })
  .openapi("GithubEnterpriseInstallBody");

const InstallResultSchema = z
  .object({
    org: z.string(),
    created: z
      .boolean()
      .openapi({ description: "False when the App was already installed." }),
    installation: z.object({
      id: z.number(),
      appSlug: z.string(),
      accountLogin: z.string(),
      repositorySelection: z.enum(["all", "selected", "none"]),
    }),
  })
  .openapi("GithubEnterpriseInstallResult");

// ─── Routes ───────────────────────────────────────────────────────────────────

const jsonError = { content: { "application/json": { schema: ErrorSchema } } };
const errorResponses = {
  401: { description: "Unauthorized", ...jsonError },
  403: { description: "Forbidden (non-admin caller)", ...jsonError },
};
const upstreamErrors = {
  404: { description: "Not found (or not found at GitHub)", ...jsonError },
  422: { description: "Refused or rejected by GitHub", ...jsonError },
  424: {
    description: "GitHub refused the configured App credentials or permission",
    ...jsonError,
  },
  429: { description: "GitHub rate limit", ...jsonError },
  502: {
    description: "GitHub unavailable or returned an unexpected response",
    ...jsonError,
  },
  504: { description: "GitHub unreachable", ...jsonError },
};
const tags = ["github-enterprise"];

const statusRoute = createRoute({
  method: "get",
  path: "/github-enterprise/apps",
  tags,
  summary: "GitHub Enterprise App status",
  description:
    "Admin-only. Metadata and key-set flag per role; never the key. Returns configured=false with null roles when nothing is set.",
  responses: {
    200: {
      description: "Status",
      content: { "application/json": { schema: StatusSchema } },
    },
    ...errorResponses,
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/github-enterprise/apps/{role}",
  tags,
  summary: "Create or replace the App for a role",
  description:
    "Admin-only. Stores the App id, slug, enterprise slug (installer) and the encrypted private key, and resets validation state. 422 when SHIPWRIGHT_ENCRYPTION_KEY is not configured.",
  request: {
    params: RoleParamSchema,
    body: { content: { "application/json": { schema: PutAppBodySchema } } },
  },
  responses: {
    200: {
      description: "Saved (metadata only)",
      content: { "application/json": { schema: AppMetadataSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    422: {
      description: "Invalid key, or encryption unavailable",
      ...jsonError,
    },
    ...errorResponses,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/github-enterprise/apps/{role}",
  tags,
  summary: "Remove the App for a role",
  description: "Admin-only. No-op when the role is not configured.",
  request: { params: RoleParamSchema },
  responses: {
    204: { description: "Removed" },
    ...errorResponses,
  },
});

const validateRoute = createRoute({
  method: "post",
  path: "/github-enterprise/apps/{role}/validate",
  tags,
  summary: "Validate the App for a role",
  description:
    "Admin-only. Authenticates as the App and checks the required permission (installer: enterprise_organization_installations write; lookup: metadata read). The outcome is persisted and returned; GitHub failures are reported as status=error with a generic message.",
  request: { params: RoleParamSchema },
  responses: {
    200: {
      description: "Validation outcome",
      content: { "application/json": { schema: ValidateResultSchema } },
    },
    404: { description: "Role not configured", ...jsonError },
    ...errorResponses,
  },
});

const orgsRoute = createRoute({
  method: "get",
  path: "/github-enterprise/orgs",
  tags,
  summary: "List installable organizations",
  description:
    "Admin-only. Lists the enterprise's installable organizations, whether each has the lookup App installed, and (with agentId) whether each has that agent's App installed. Returns configured=false and no orgs when the installer App is not set.",
  request: { query: OrgsQuerySchema },
  responses: {
    200: {
      description: "Organizations",
      content: { "application/json": { schema: OrgsResultSchema } },
    },
    ...upstreamErrors,
    ...errorResponses,
  },
});

const installRoute = createRoute({
  method: "post",
  path: "/github-enterprise/orgs/{org}/install",
  tags,
  summary: "Install an agent's App on an organization",
  description:
    "Admin-only. Uses the agent's stored GH_APP_CLIENT_ID when set; otherwise resolves the stored GH_APP_SLUG and looks the App up through the public GET /apps/{slug} to get its client id. Installs it on the org with the installer App. 422 for an agent with neither a stored client id nor a slug, and for a private App (not visible to the public lookup) with no stored client id; 409 when the installer App is not configured.",
  request: {
    params: OrgParamSchema,
    body: { content: { "application/json": { schema: InstallBodySchema } } },
  },
  responses: {
    200: {
      description: "Installed (or already installed)",
      content: { "application/json": { schema: InstallResultSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    409: { description: "Installer App not configured", ...jsonError },
    ...upstreamErrors,
    ...errorResponses,
  },
});

// ─── Error mapping ────────────────────────────────────────────────────────────

interface Mapped {
  status: 404 | 422 | 424 | 429 | 502 | 504;
  message: string;
}

/**
 * Distinct, non-leaky mapping of client failures. Never forwards GitHub's
 * message text or the client's (redacted) message.
 */
export function mapEnterpriseFailure(kind: GithubEnterpriseErrorKind): Mapped {
  switch (kind) {
    case "unauthorized":
      return {
        status: 424,
        message:
          "GitHub rejected the configured App credentials; re-validate the App and re-save its private key.",
      };
    case "permission":
      return {
        status: 424,
        message:
          "GitHub denied the request: the App lacks the required permission or is not installed on the enterprise.",
      };
    case "not_found":
      return {
        status: 404,
        message:
          "GitHub could not find the enterprise, organization or App for this request.",
      };
    case "validation":
      return {
        status: 422,
        message: "GitHub rejected the request as invalid.",
      };
    case "rate_limit":
      return {
        status: 429,
        message: "GitHub rate limit reached; retry later.",
      };
    case "server":
      return {
        status: 502,
        message: "GitHub is unavailable (server error); retry later.",
      };
    case "network":
      return { status: 504, message: "GitHub could not be reached." };
    default:
      return {
        status: 502,
        message: "GitHub returned an unexpected response.",
      };
  }
}

function serializeApp(m: GitHubEnterpriseAppMetadata) {
  return {
    role: m.role,
    appId: m.appId,
    slug: m.slug,
    enterpriseSlug: m.enterpriseSlug,
    keySet: m.keySet,
    lastValidationStatus: m.lastValidationStatus,
    lastValidatedAt: m.lastValidatedAt?.toISOString() ?? null,
    lastValidationError: m.lastValidationError,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

// ─── Access preview (GHE-2.4) ─────────────────────────────────────────────────

/**
 * Backs GET /agents/:id/github-access. Unconfigured (either App missing, or a
 * stored App without its key / enterprise slug) returns before any GitHub
 * call. A GitHub failure while listing orgs is rethrown as a 502 carrying only
 * the mapped, non-leaky message.
 */
export function createGithubAccessPreview(
  deps: Pick<
    GithubEnterpriseApiDeps,
    "appService" | "fetchFn" | "apiBase" | "now"
  >,
): GithubAccessPreviewFn {
  return async (username) => {
    const [installer, lookup] = await Promise.all([
      deps.appService.get("installer"),
      deps.appService.get("lookup"),
    ]);
    if (!installer || !lookup || !installer.enterpriseSlug) {
      return { status: "unconfigured" };
    }
    const [installerKey, lookupKey] = await Promise.all([
      deps.appService.getPrivateKey("installer"),
      deps.appService.getPrivateKey("lookup"),
    ]);
    if (!installerKey || !lookupKey) return { status: "unconfigured" };

    const common = {
      apiBase: deps.apiBase,
      fetchFn: deps.fetchFn,
      now: deps.now,
    };
    const resolver = new UserRepoAccessResolver({
      installer: new GithubEnterpriseClient({
        appId: installer.appId,
        enterprise: installer.enterpriseSlug,
        privateKey: installerKey,
        ...common,
      }),
      lookup: new GithubLookupClient({
        appId: lookup.appId,
        privateKey: lookupKey,
        ...common,
      }),
      now: deps.now,
    });
    try {
      const access = await resolver.resolve(username);
      return { status: access.outcome, access };
    } catch (err) {
      if (err instanceof GithubEnterpriseError) {
        throw new BadGatewayError(mapEnterpriseFailure(err.kind).message);
      }
      // Anything else (e.g. JWT signing): generic, no detail.
      throw new BadGatewayError("GitHub access could not be resolved.");
    }
  };
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function createGithubEnterpriseApp(
  deps: GithubEnterpriseApiDeps,
): OpenAPIHono<AdminAuthEnv> {
  const { appService } = deps;

  const app = new OpenAPIHono<AdminAuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ");
        return c.json({ error: message }, 400);
      }
    },
  });

  app.onError((err, c) => {
    if (err instanceof GithubEnterpriseError) {
      const mapped = mapEnterpriseFailure(err.kind);
      if (mapped.status === 429 && err.retryAfterSeconds) {
        c.header("Retry-After", String(Math.ceil(err.retryAfterSeconds)));
      }
      return c.json({ error: mapped.message }, mapped.status);
    }
    if (err instanceof ApiError) {
      // ApiError messages are authored in this repo and never carry key material.
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500,
      );
    }
    if (err instanceof HTTPException && err.status < 500) {
      return c.json({ error: err.message }, err.status as 400 | 415);
    }
    // Deliberately log only the class: an unexpected error must not echo key material.
    console.error(
      "[github-enterprise-api] unhandled error:",
      err instanceof Error ? err.name : typeof err,
    );
    return c.json({ error: "Internal server error" }, 500);
  });

  app.use(
    "/github-enterprise/*",
    createAdminAuthMiddleware({
      sessionSecret: deps.sessionSecret,
      agentTokenService: deps.agentTokenService,
      adminApiKeys: deps.adminApiKeys,
    }),
  );

  const requireAdmin = (c: { get: (k: "isAdmin") => unknown }) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError("Admin access required");
    }
  };

  const clientFor = async (
    meta: GitHubEnterpriseAppMetadata,
  ): Promise<GithubEnterpriseClient> => {
    const privateKey = await appService.getPrivateKey(
      meta.role as GitHubEnterpriseAppRole,
    );
    if (!privateKey || !meta.enterpriseSlug) {
      throw new UnprocessableEntityError(
        "the installer App is missing its key or enterprise slug; re-save it",
      );
    }
    return new GithubEnterpriseClient({
      appId: meta.appId,
      enterprise: meta.enterpriseSlug,
      privateKey,
      apiBase: deps.apiBase,
      fetchFn: deps.fetchFn,
      now: deps.now,
    });
  };

  /**
   * Agent's stored App slug (null when absent/invalid) and stored client id
   * (null when absent/malformed). 404 when the agent is unknown.
   */
  const agentApp = async (
    agentId: string,
  ): Promise<{
    slug: string | null;
    invalid: boolean;
    clientId: string | null;
  }> => {
    if (!(await deps.agentService.getSummary(agentId))) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }
    const env = (await deps.agentEnvService.getByAgentId(agentId))?.env;
    const storedClientId = env?.GH_APP_CLIENT_ID?.trim();
    const clientId =
      storedClientId && CLIENT_ID_RE.test(storedClientId)
        ? storedClientId
        : null;
    const slug = env?.GH_APP_SLUG;
    if (!slug) return { slug: null, invalid: false, clientId };
    return SLUG_RE.test(slug)
      ? { slug, invalid: false, clientId }
      : { slug: null, invalid: true, clientId };
  };

  /** Public-lookup client id; reason is set when the App is private (404). */
  const publicClientId = async (
    slug: string,
  ): Promise<{ clientId: string | null; privateApp: boolean }> => {
    try {
      const app = await fetchPublicApp(slug, {
        apiBase: deps.apiBase,
        fetchFn: deps.fetchFn,
      });
      return { clientId: app.clientId, privateApp: false };
    } catch (err) {
      if (err instanceof GithubEnterpriseError && err.kind === "not_found") {
        return { clientId: null, privateApp: true };
      }
      throw err;
    }
  };

  const privateAppMessage = (slug: string) =>
    `the agent's App '${slug}' is private (not visible to the public lookup) and cannot be installed through the enterprise API; store its GH_APP_CLIENT_ID on the agent`;

  app.openapi(statusRoute, async (c) => {
    requireAdmin(c);
    const rows = await appService.list();
    const byRole = (role: string) => {
      const r = rows.find((x) => x.role === role);
      return r ? serializeApp(r) : null;
    };
    return c.json(
      {
        configured: rows.length > 0,
        installer: byRole("installer"),
        lookup: byRole("lookup"),
      },
      200,
    );
  });

  app.openapi(putRoute, async (c) => {
    requireAdmin(c);
    const { role } = c.req.valid("param");
    const body = c.req.valid("json");
    if (role === "installer" && !body.enterpriseSlug) {
      throw new UnprocessableEntityError(
        "enterpriseSlug is required for the installer role",
      );
    }
    try {
      createPrivateKey(body.privateKey);
    } catch {
      // Never echo the submitted value.
      throw new UnprocessableEntityError(
        "privateKey is not a valid PEM private key",
      );
    }
    const saved = await appService.save({
      role,
      appId: body.appId,
      slug: body.slug,
      enterpriseSlug: body.enterpriseSlug ?? null,
      privateKey: body.privateKey,
    });
    return c.json(serializeApp(saved), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    requireAdmin(c);
    await appService.delete(c.req.valid("param").role);
    return c.body(null, 204);
  });

  app.openapi(validateRoute, async (c) => {
    requireAdmin(c);
    const { role } = c.req.valid("param");
    const meta = await appService.get(role);
    if (!meta) throw new NotFoundError(`no '${role}' App is configured`);
    const privateKey = await appService.getPrivateKey(role);
    if (!privateKey) throw new NotFoundError(`no '${role}' App is configured`);

    const required = REQUIRED_PERMISSION[role];
    let granted: Record<string, string> = {};
    let status: "valid" | "missing_permission" | "error";
    let error: string | null = null;
    let warnings: string[] = [];
    try {
      if (role === "installer") {
        if (!meta.enterpriseSlug) {
          throw new UnprocessableEntityError(
            "the installer App has no enterprise slug; re-save it",
          );
        }
        const client = new GithubEnterpriseClient({
          appId: meta.appId,
          enterprise: meta.enterpriseSlug,
          privateKey,
          apiBase: deps.apiBase,
          fetchFn: deps.fetchFn,
          now: deps.now,
        });
        granted = (await client.getInstallationToken()).permissions ?? {};
      } else {
        granted = (
          await fetchAuthenticatedApp({
            appId: meta.appId,
            privateKey,
            apiBase: deps.apiBase,
            fetchFn: deps.fetchFn,
            now: deps.now,
          })
        ).permissions;
      }
      const resolved = resolveValidation(role, required, granted);
      status = resolved.status;
      error = resolved.error;
      warnings = resolved.warnings;
    } catch (err) {
      status = "error";
      if (
        err instanceof GithubEnterpriseError &&
        err.kind === "not_found" &&
        err.step === "installation_lookup"
      ) {
        error = `the App is not installed on enterprise ${meta.enterpriseSlug}, or the enterprise slug is wrong`;
      } else if (err instanceof GithubEnterpriseError) {
        error = mapEnterpriseFailure(err.kind).message;
      } else if (err instanceof ApiError) {
        error = err.message;
      } else {
        // JWT signing failure and anything else: generic, no detail.
        error = "the stored private key could not be used to sign a request";
      }
    }

    await appService.recordValidation(role, { status, error });
    const updated = await appService.get(role);
    return c.json(
      {
        role,
        ok: status === "valid",
        status,
        requiredPermission: required.name,
        grantedPermissions: granted,
        error,
        warnings,
        app: updated ? serializeApp(updated) : null,
      },
      200,
    );
  });

  app.openapi(orgsRoute, async (c) => {
    requireAdmin(c);
    const { agentId } = c.req.valid("query");
    const installer = await appService.get("installer");
    if (!installer) return c.json({ configured: false, orgs: [] }, 200);

    let agentAppSlug: string | null = null;
    let agentAppReason: string | null = null;
    if (agentId) {
      const agent = await agentApp(agentId);
      agentAppSlug = agent.slug;
      if (!agent.clientId) {
        if (!agent.slug) {
          agentAppReason =
            "the agent has no GH_APP_SLUG or GH_APP_CLIENT_ID; it has no GitHub App to install";
        } else {
          try {
            if ((await publicClientId(agent.slug)).privateApp) {
              agentAppReason = privateAppMessage(agent.slug);
            }
          } catch {
            // The reason is advisory; a lookup failure must not fail the listing.
          }
        }
      }
    }
    const lookup = await appService.get("lookup");

    const client = await clientFor(installer);
    const orgs = await client.listInstallableOrganizations();
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const needInstallations = lookup !== null || agentAppSlug !== null;

    const result = [];
    for (const o of orgs) {
      let installs: AppInstallation[] = [];
      if (needInstallations)
        installs = await client.listOrgInstallations(o.login);
      result.push({
        id: o.id,
        login: o.login,
        lookupAppInstalled: lookup
          ? installs.some((i) => same(i.appSlug, lookup.slug))
          : null,
        agentAppInstalled: agentAppSlug
          ? installs.some((i) => same(i.appSlug, agentAppSlug as string))
          : null,
      });
    }
    return c.json(
      {
        configured: true,
        ...(agentId ? { agentAppSlug, agentAppReason } : {}),
        orgs: result,
      },
      200,
    );
  });

  app.openapi(installRoute, async (c) => {
    requireAdmin(c);
    const { org } = c.req.valid("param");
    const body = c.req.valid("json");

    const installer = await appService.get("installer");
    if (!installer) {
      throw new ConflictError("the installer App is not configured");
    }
    const agent = await agentApp(body.agentId);
    let clientId = agent.clientId;
    if (!clientId) {
      if (agent.invalid) {
        throw new UnprocessableEntityError(
          "the agent's stored GH_APP_SLUG is not a valid GitHub App slug",
        );
      }
      if (!agent.slug) {
        throw new UnprocessableEntityError(
          "the agent has no GH_APP_SLUG or GH_APP_CLIENT_ID; it has no GitHub App to install",
        );
      }
      const lookedUp = await publicClientId(agent.slug);
      if (lookedUp.privateApp) {
        throw new UnprocessableEntityError(privateAppMessage(agent.slug));
      }
      clientId = lookedUp.clientId;
      if (!clientId) {
        throw new UnprocessableEntityError(
          `the agent's App '${agent.slug}' did not expose a client id and cannot be installed`,
        );
      }
    }

    const client = await clientFor(installer);
    const res = await client.installOnOrg(org, {
      clientId,
      repositorySelection: body.repositorySelection,
      ...(body.repositories ? { repositories: body.repositories } : {}),
    });
    return c.json(
      {
        org,
        created: res.created,
        installation: {
          id: res.installation.id,
          appSlug: res.installation.appSlug,
          accountLogin: res.installation.accountLogin,
          repositorySelection: res.installation.repositorySelection,
        },
      },
      200,
    );
  });

  return app;
}
