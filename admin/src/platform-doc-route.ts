/**
 * admin/src/platform-doc-route.ts
 * Optional GET /doc route serving the platform OpenAPI 3.1 document.
 *
 * Mounted only when SHIPWRIGHT_ADMIN_DOC_ENABLED === "enabled"; otherwise the
 * route is absent (Hono 404, identical to a build without this module). It
 * serves buildPlatformAdminSpec() only — never extension (coding) paths — so
 * the body matches the committed admin/openapi.platform.json byte-for-byte.
 */

import type { Hono, MiddlewareHandler } from "hono";
import { buildPlatformAdminSpec } from "./admin-spec.ts";

export const DOC_ENABLED_ENV = "SHIPWRIGHT_ADMIN_DOC_ENABLED";

export function isPlatformDocEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env[DOC_ENABLED_ENV] === "enabled";
}

/** Mounts GET /doc behind `auth` when the flag is on; a no-op otherwise. */
export function mountPlatformDoc(
  // biome-ignore lint/suspicious/noExplicitAny: the root app carries arbitrary Env generics
  root: Hono<any>,
  deps: {
    env: Record<string, string | undefined>;
    auth: MiddlewareHandler;
  },
): void {
  if (!isPlatformDocEnabled(deps.env)) return;
  // Same serialization as the committed spec file (2-space JSON + newline).
  const body = `${JSON.stringify(buildPlatformAdminSpec(), null, 2)}\n`;
  root.get("/doc", deps.auth, (c) =>
    c.body(body, 200, {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    }),
  );
}
