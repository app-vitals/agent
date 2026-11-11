/**
 * admin/src/admin-ui-github-enterprise.ts
 * GET/POST /admin/settings/github-enterprise — admin-only settings page for
 * the optional enterprise GitHub Apps (GHE-1.4). A thin UI over the GHE-1.3
 * /github-enterprise API: every action calls that API (with the caller's
 * session cookie, so its own admin check applies) and surfaces its typed
 * `{ error }` bodies as readable messages. No key is ever read back.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { readPrivateKeyField } from "./github-enterprise-pem-upload.ts";
import { warningCodeFor } from "./github-enterprise-warnings.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import {
  ADMIN_GITHUB_ENTERPRISE_PATH as BASE,
  type GheOrgs,
  type GheStatus,
  renderGithubEnterpriseSettingsPage,
} from "./admin-ui-github-enterprise-pages.ts";

export interface AdminGithubEnterpriseRouteDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  /** Calls the GHE-1.3 API app (its `.request`), e.g. `/github-enterprise/apps`. */
  api: (path: string, init?: RequestInit) => Response | Promise<Response>;
  html: (content: string, opts?: { status?: number }) => Response;
}

const NOTICES: Record<string, string> = {
  saved: "Credentials saved. Validate the app to check its permissions.",
  deleted: "App removed.",
  validated: "Validation finished; see the status below.",
  installed: "Agent app installed.",
  already: "The agent app was already installed on that organization.",
};

// Deliberately not imported from the enterprise credential service: that
// key-bearing module stays out of the UI layer (see the isolation test).
const ROLES = ["installer", "lookup"] as const;
const isRole = (v: string): v is (typeof ROLES)[number] =>
  (ROLES as readonly string[]).includes(v);

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export function registerAdminGithubEnterpriseRoutes(
  app: Hono<AdminUIEnv>,
  deps: AdminGithubEnterpriseRouteDeps,
): void {
  const requireAdmin: MiddlewareHandler<AdminUIEnv> = async (c, next) =>
    c.var.isAdmin === true
      ? next()
      : new Response("Forbidden", { status: 403 });

  async function call<T>(
    c: Context<AdminUIEnv>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    const cookie = c.req.header("cookie");
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await deps.api(path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { ok: false, status: 500, error: "The request failed." };
    }
    if (res.ok) {
      const data = res.status === 204 ? undefined : ((await res.json()) as T);
      return { ok: true, status: res.status, data };
    }
    let error = `The request failed (HTTP ${res.status}).`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === "string" && j.error) error = j.error;
    } catch {
      // keep the generic message
    }
    return { ok: false, status: res.status, error };
  }

  async function renderPage(
    c: Context<AdminUIEnv>,
    flash: { error?: string; notice?: string; status?: number } = {},
  ): Promise<Response> {
    const agentId = c.req.query("agentId")?.trim() || undefined;
    const statusRes = await call<GheStatus>(
      c,
      "GET",
      "/github-enterprise/apps",
    );
    if (!statusRes.ok || !statusRes.data) {
      return deps.html(
        renderGithubEnterpriseSettingsPage({
          userEmail: c.var.userEmail,
          status: { configured: false, installer: null, lookup: null },
          error: flash.error ?? statusRes.error,
        }),
        { status: statusRes.status >= 400 ? statusRes.status : 500 },
      );
    }
    const status = statusRes.data;
    let orgs: GheOrgs | undefined;
    let orgsError: string | undefined;
    if (status.installer) {
      const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
      const r = await call<GheOrgs>(c, "GET", `/github-enterprise/orgs${qs}`);
      if (r.ok) orgs = r.data;
      else orgsError = r.error;
    }
    const noticeKey = c.req.query("notice");
    const notice = flash.notice ?? (noticeKey ? NOTICES[noticeKey] : undefined);
    return deps.html(
      renderGithubEnterpriseSettingsPage({
        userEmail: c.var.userEmail,
        status,
        orgs,
        orgsError,
        agentId,
        error: flash.error,
        notice,
        warnings: c.req.query("warn")?.split(",").filter(Boolean),
      }),
      { status: flash.status ?? 200 },
    );
  }

  const field = (form: FormData, name: string) =>
    (form.get(name)?.toString() ?? "").trim();
  async function readForm(c: Context<AdminUIEnv>): Promise<FormData> {
    try {
      return await c.req.formData();
    } catch {
      return new FormData();
    }
  }
  const back = (c: Context<AdminUIEnv>, notice: string, agentId?: string) =>
    c.redirect(
      `${BASE}?notice=${notice}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`,
      302,
    );
  const fail = (c: Context<AdminUIEnv>, r: ApiResult<unknown>) =>
    renderPage(c, { error: r.error, status: r.status >= 400 ? r.status : 400 });

  app.get(BASE, deps.requireAuth, requireAdmin, (c) => renderPage(c));

  app.post(`${BASE}/apps/:role`, deps.requireAuth, requireAdmin, async (c) => {
    const role = c.req.param("role");
    if (!isRole(role)) return new Response("Not Found", { status: 404 });
    const form = await readForm(c);
    const enterpriseSlug = field(form, "enterpriseSlug");
    const key = await readPrivateKeyField(form);
    if (!key.ok) return renderPage(c, { error: key.error, status: 400 });
    const r = await call(c, "PUT", `/github-enterprise/apps/${role}`, {
      appId: field(form, "appId"),
      slug: field(form, "slug"),
      ...(enterpriseSlug ? { enterpriseSlug } : {}),
      // Pasted or uploaded; never echoed back to the page.
      privateKey: key.pem,
    });
    return r.ok ? back(c, "saved") : fail(c, r);
  });

  app.post(
    `${BASE}/apps/:role/validate`,
    deps.requireAuth,
    requireAdmin,
    async (c) => {
      const role = c.req.param("role");
      if (!isRole(role)) return new Response("Not Found", { status: 404 });
      const r = await call<{ warnings?: string[] }>(
        c,
        "POST",
        `/github-enterprise/apps/${role}/validate`,
      );
      if (!r.ok) return fail(c, r);
      // Warnings ride the redirect as stable codes, never free text.
      const codes = (r.data?.warnings ?? [])
        .map(warningCodeFor)
        .filter((x): x is NonNullable<typeof x> => x !== undefined);
      return c.redirect(
        `${BASE}?notice=validated${codes.length ? `&warn=${codes.join(",")}` : ""}`,
        302,
      );
    },
  );

  app.post(
    `${BASE}/apps/:role/delete`,
    deps.requireAuth,
    requireAdmin,
    async (c) => {
      const role = c.req.param("role");
      if (!isRole(role)) return new Response("Not Found", { status: 404 });
      const r = await call(c, "DELETE", `/github-enterprise/apps/${role}`);
      return r.ok ? back(c, "deleted") : fail(c, r);
    },
  );

  app.post(
    `${BASE}/orgs/:org/install`,
    deps.requireAuth,
    requireAdmin,
    async (c) => {
      const org = c.req.param("org");
      const agentId = field(await readForm(c), "agentId");
      if (!agentId) {
        return renderPage(c, { error: "Agent ID is required.", status: 400 });
      }
      const r = await call<{ created: boolean }>(
        c,
        "POST",
        `/github-enterprise/orgs/${encodeURIComponent(org)}/install`,
        { agentId },
      );
      if (!r.ok) return fail(c, r);
      return back(
        c,
        r.data?.created === false ? "already" : "installed",
        agentId,
      );
    },
  );
}
