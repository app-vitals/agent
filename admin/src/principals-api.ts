/**
 * admin/src/principals-api.ts
 * Admin-only /principals lookup API (ACM-1.1):
 *   POST /principals/lookup   {ids} -> {principals:[{id,type,email}], notFound:[id]}
 *   GET  /principals/by-email ?email= -> {id,type,email} (404 when unknown)
 * Auth: admin cookie or scope "*" key; every other caller class gets 403.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { AgentTokenService } from "./agent-tokens.ts";
import {
  type AdminApiKey,
  type AdminAuthEnv,
  createAdminAuthMiddleware,
} from "./api-auth.ts";
import { ApiError, ForbiddenError, NotFoundError } from "./errors.ts";
import {
  ErrorSchema,
  PrincipalByEmailQuerySchema,
  PrincipalLookupBodySchema,
  PrincipalLookupResponseSchema,
  PrincipalSchema,
} from "./openapi-schemas.ts";
import type { PrincipalLookupService } from "./principal-lookup.ts";

interface PrincipalsApiDeps {
  lookup: Pick<PrincipalLookupService, "resolveMany" | "findIdByEmail">;
  sessionSecret: string;
  adminApiKeys?: Map<string, AdminApiKey>;
  agentTokenService: Pick<AgentTokenService, "validate">;
}

const jsonError = { content: { "application/json": { schema: ErrorSchema } } };

const errorResponses = {
  401: { description: "Unauthorized", ...jsonError },
  403: { description: "Forbidden (non-admin caller)", ...jsonError },
};

const lookupRoute = createRoute({
  method: "post",
  path: "/principals/lookup",
  tags: ["principals"],
  summary: "Batch-resolve principal ids",
  description:
    "Admin-only. Resolves AccountMember ids (type user) and Agent ids (type agent) to type and email. Agents have no email (null). Unknown ids are listed in notFound; they are not an error.",
  request: {
    body: {
      content: { "application/json": { schema: PrincipalLookupBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Resolved principals and unknown ids",
      content: {
        "application/json": { schema: PrincipalLookupResponseSchema },
      },
    },
    400: { description: "Bad request", ...jsonError },
    ...errorResponses,
  },
});

const byEmailRoute = createRoute({
  method: "get",
  path: "/principals/by-email",
  tags: ["principals"],
  summary: "Resolve an email to its principal id",
  description:
    "Admin-only. Case-insensitive (emails are stored lowercased). 404 when no member has the email.",
  request: { query: PrincipalByEmailQuerySchema },
  responses: {
    200: {
      description: "Principal",
      content: { "application/json": { schema: PrincipalSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    404: { description: "No principal with that email", ...jsonError },
    ...errorResponses,
  },
});

export function createPrincipalsApp(
  deps: PrincipalsApiDeps,
): OpenAPIHono<AdminAuthEnv> {
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
    console.error("[principals-api] unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.use(
    "/principals/*",
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

  app.openapi(lookupRoute, async (c) => {
    requireAdmin(c);
    const { ids } = c.req.valid("json");
    return c.json(await deps.lookup.resolveMany(ids), 200);
  });

  app.openapi(byEmailRoute, async (c) => {
    requireAdmin(c);
    const { email } = c.req.valid("query");
    const principal = await deps.lookup.findIdByEmail(email);
    if (!principal) throw new NotFoundError("no principal with that email");
    return c.json(principal, 200);
  });

  return app;
}
