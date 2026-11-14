/**
 * admin/src/agent-templates-api.ts
 * /templates API (ATP-1.3): list, read, create/replace and delete agent
 * templates and their items.
 *
 * Auth: platform admins (admin key or admin session) manage every template,
 * including deployment-wide ones. A session user with an account (resolved
 * through the caller-scope resolver, never from the request) manages only that
 * account's templates. Every other caller (agent keys, platform.* keys,
 * members without an account) gets 403.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { accountIdFromScope } from "./account-agent-create.ts";
import type {
  AgentTemplateService,
  TemplateActor,
  TemplateView,
} from "./agent-templates.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import {
  type AdminApiKey,
  type AdminAuthEnv,
  createAdminAuthMiddleware,
} from "./api-auth.ts";
import type { CallerScopeResolver } from "./caller-scope.ts";
import { ApiError, ForbiddenError } from "./errors.ts";
import {
  AgentTemplateSchema,
  AgentTemplatesListSchema,
  ErrorSchema,
  ListTemplatesQuerySchema,
  PutTemplateBodySchema,
  TemplateIdParamSchema,
  TemplateItemInputSchema,
  TemplateItemKeyQuerySchema,
} from "./openapi-schemas.ts";

export interface AgentTemplatesApiDeps {
  templateService: Pick<
    AgentTemplateService,
    "list" | "get" | "replace" | "putItem" | "deleteItem" | "delete"
  >;
  callerScopeResolver: CallerScopeResolver;
  sessionSecret: string;
  adminApiKeys?: Map<string, AdminApiKey>;
  agentTokenService: Pick<AgentTokenService, "validate">;
}

const jsonError = { content: { "application/json": { schema: ErrorSchema } } };

const errorResponses = {
  401: { description: "Unauthorized", ...jsonError },
  403: {
    description:
      "Forbidden (caller has no account, or names another account / the deployment scope)",
    ...jsonError,
  },
  404: {
    description: "Template not found (or not in the caller's account)",
    ...jsonError,
  },
};

const templateResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: AgentTemplateSchema } },
});

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/templates",
  tags: ["templates"],
  summary: "List agent templates",
  description:
    "Platform admins see every template (optionally narrowed by `accountId` / `specialty`); account callers see only their account's. Secret env values are masked as `***`.",
  request: { query: ListTemplatesQuerySchema },
  responses: {
    200: {
      description: "Templates",
      content: { "application/json": { schema: AgentTemplatesListSchema } },
    },
    ...errorResponses,
  },
});

const getTemplateRoute = createRoute({
  method: "get",
  path: "/templates/{id}",
  tags: ["templates"],
  summary: "Get an agent template",
  description:
    "Returns the template with its items. Secret env values are masked as `***`; non-secret ones are returned in clear.",
  request: { params: TemplateIdParamSchema },
  responses: { 200: templateResponse("Template"), ...errorResponses },
});

const putTemplateRoute = createRoute({
  method: "put",
  path: "/templates",
  tags: ["templates"],
  summary: "Create or replace an agent template",
  description:
    'Creates the template for the (accountId, specialty) scope, or replaces the items of the existing one (201 / 200). Account callers may only write their own account (403 otherwise); only platform admins write deployment-wide templates. 422 for an unknown specialty, a denylisted env key (per-agent credentials: Slack tokens, GH_TOKEN, Anthropic credentials, task-store URL/token), an invalid item payload, a cron item without a name key, or a duplicate (kind, key). Env values are encrypted at rest; a secret env item sent as `"***"` keeps its stored value.',
  request: {
    body: {
      content: { "application/json": { schema: PutTemplateBodySchema } },
    },
  },
  responses: {
    200: templateResponse("Template replaced"),
    201: templateResponse("Template created"),
    400: { description: "Bad request", ...jsonError },
    422: { description: "Validation failed", ...jsonError },
    ...errorResponses,
  },
});

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/templates/{id}",
  tags: ["templates"],
  summary: "Delete an agent template",
  description: "Deletes the template and all of its items.",
  request: { params: TemplateIdParamSchema },
  responses: {
    204: { description: "Template deleted" },
    ...errorResponses,
  },
});

const putItemRoute = createRoute({
  method: "put",
  path: "/templates/{id}/items",
  tags: ["templates"],
  summary: "Add or replace a template item",
  description:
    "Upserts one item by (kind, key) without touching the others. Same validation as PUT /templates (422).",
  request: {
    params: TemplateIdParamSchema,
    body: {
      content: { "application/json": { schema: TemplateItemInputSchema } },
    },
  },
  responses: {
    200: templateResponse("Template with the item applied"),
    400: { description: "Bad request", ...jsonError },
    422: { description: "Validation failed", ...jsonError },
    ...errorResponses,
  },
});

const deleteItemRoute = createRoute({
  method: "delete",
  path: "/templates/{id}/items",
  tags: ["templates"],
  summary: "Remove a template item",
  description:
    "Removes the item identified by the `kind` and `key` query params (a query rather than a path segment because plugin and tool keys can contain `/`). 404 when it does not exist.",
  request: { params: TemplateIdParamSchema, query: TemplateItemKeyQuerySchema },
  responses: {
    204: { description: "Item removed" },
    ...errorResponses,
  },
});

function serialize(t: TemplateView) {
  return {
    id: t.id,
    accountId: t.accountId,
    specialty: t.specialty,
    items: t.items.map((i) => ({
      kind: i.kind,
      key: i.key,
      payload: i.payload,
      updatedAt: i.updatedAt.toISOString(),
    })),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function createAgentTemplatesApp(
  deps: AgentTemplatesApiDeps,
): OpenAPIHono<AdminAuthEnv> {
  const { templateService, callerScopeResolver } = deps;

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
    if (err instanceof ApiError && err.statusCode < 500) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 422,
      );
    }
    if (err instanceof HTTPException && err.status < 500) {
      return c.json({ error: err.message }, err.status as 400 | 415);
    }
    console.error("[agent-templates-api] unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // "/templates/*" also matches the bare "/templates" path in Hono.
  app.use(
    "/templates/*",
    createAdminAuthMiddleware({
      sessionSecret: deps.sessionSecret,
      agentTokenService: deps.agentTokenService,
      adminApiKeys: deps.adminApiKeys,
      callerScopeResolver,
    }),
  );

  async function resolveActor(c: {
    get: {
      (k: "isAdmin"): boolean;
      (k: "callerEmail"): string | undefined;
    };
  }): Promise<TemplateActor> {
    if (c.get("isAdmin") === true) return { kind: "admin" };
    const email = c.get("callerEmail");
    const accountId =
      email === undefined
        ? null
        : accountIdFromScope(await callerScopeResolver(email, false));
    if (accountId === null) {
      throw new ForbiddenError("Admin or account access required");
    }
    return { kind: "account", accountId };
  }

  app.openapi(listTemplatesRoute, async (c) => {
    const actor = await resolveActor(c);
    const templates = await templateService.list(actor, c.req.valid("query"));
    return c.json({ templates: templates.map(serialize) }, 200);
  });

  app.openapi(getTemplateRoute, async (c) => {
    const actor = await resolveActor(c);
    const t = await templateService.get(actor, c.req.valid("param").id);
    return c.json(serialize(t), 200);
  });

  app.openapi(putTemplateRoute, async (c) => {
    const actor = await resolveActor(c);
    const body = c.req.valid("json");
    const { template, created } = await templateService.replace(
      actor,
      {
        ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
        ...(body.specialty !== undefined ? { specialty: body.specialty } : {}),
      },
      body.items,
    );
    return c.json(serialize(template), created ? 201 : 200);
  });

  app.openapi(deleteTemplateRoute, async (c) => {
    const actor = await resolveActor(c);
    await templateService.delete(actor, c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.openapi(putItemRoute, async (c) => {
    const actor = await resolveActor(c);
    const t = await templateService.putItem(
      actor,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return c.json(serialize(t), 200);
  });

  app.openapi(deleteItemRoute, async (c) => {
    const actor = await resolveActor(c);
    const { kind, key } = c.req.valid("query");
    await templateService.deleteItem(actor, c.req.valid("param").id, kind, key);
    return c.body(null, 204);
  });

  return app;
}
