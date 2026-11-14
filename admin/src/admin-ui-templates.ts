/**
 * admin/src/admin-ui-templates.ts
 * GET/POST /admin/settings/templates — the Settings > Templates editor
 * (ATP-2.3). A thin UI over AgentTemplateService (the same service behind the
 * ATP-1.3 /templates API), called directly with the same actor rules: platform
 * admins edit every scope (including deployment-wide); an account member sees
 * and edits only their own account's scopes; everyone else gets 403. Service
 * errors (denylisted env key, unknown specialty, bad payload) are shown inline.
 */

import type { SettingsNav } from "./admin-ui-settings-layout.ts";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { accountIdFromScope } from "./account-agent-create.ts";
import type { AccountService } from "./accounts.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import {
  ADMIN_TEMPLATES_PATH as BASE,
  renderTemplatesPage,
  type TemplateItemRow,
  type TemplateScopeOption,
} from "./admin-ui-templates-pages.ts";
import {
  AGENT_TEMPLATE_ITEM_KINDS,
  type AgentTemplateItemKind,
} from "./agent-template-items.ts";
import type {
  AgentTemplateService,
  TemplateActor,
  TemplateItemInput,
  TemplateView,
} from "./agent-templates.ts";
import type { CallerScopeResolver } from "./caller-scope.ts";
import { ApiError, ForbiddenError } from "./errors.ts";
import type { SpecialtyTypeResolver } from "./specialty-types.ts";

export interface AdminTemplatesRouteDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  templateService: Pick<
    AgentTemplateService,
    "list" | "replace" | "putItem" | "deleteItem" | "delete"
  >;
  callerScopeResolver: CallerScopeResolver;
  /** Settings sidebar nav (SGL-2.2). */
  settingsNav?: SettingsNav;
  /** Optional: without it admins can only pick deployment-wide. */
  accounts?: Pick<AccountService, "listWithCounts" | "getWithCounts">;
  specialtyRegistry: Pick<SpecialtyTypeResolver, "listTypes">;
  html: (content: string, opts?: { status?: number }) => Response;
}

const NOTICES: Record<string, string> = {
  saved: "Saved.",
  removed: "Item removed.",
  deleted: "Template deleted.",
};

const isKind = (v: string): v is AgentTemplateItemKind =>
  (AGENT_TEMPLATE_ITEM_KINDS as readonly string[]).includes(v);

interface Scope {
  /** "" = deployment-wide. */
  accountId: string;
  /** "" = every agent type. */
  specialty: string;
}

export function registerAdminTemplatesRoutes(
  app: Hono<AdminUIEnv>,
  deps: AdminTemplatesRouteDeps,
): void {
  async function resolveActor(c: Context<AdminUIEnv>): Promise<TemplateActor> {
    if (c.var.isAdmin === true) return { kind: "admin" };
    const accountId = accountIdFromScope(
      await deps.callerScopeResolver(c.var.userEmail, false),
    );
    if (accountId === null) {
      throw new ForbiddenError("Admin or account access required");
    }
    return { kind: "account", accountId };
  }

  /** Account members are pinned to their account; naming another is 403. */
  function resolveScope(
    actor: TemplateActor,
    accountId: string,
    specialty: string,
  ): Scope {
    if (actor.kind === "account") {
      if (accountId !== "" && accountId !== actor.accountId) {
        throw new ForbiddenError(
          "cannot manage another account's or deployment-wide templates",
        );
      }
      return { accountId: actor.accountId, specialty };
    }
    return { accountId, specialty };
  }

  async function findTemplate(
    actor: TemplateActor,
    scope: Scope,
  ): Promise<TemplateView | undefined> {
    const templates = await deps.templateService.list(actor, {
      ...(scope.accountId !== "" ? { accountId: scope.accountId } : {}),
      ...(scope.specialty !== "" ? { specialty: scope.specialty } : {}),
    });
    return templates.find(
      (t) =>
        (t.accountId ?? "") === scope.accountId &&
        (t.specialty ?? "") === scope.specialty,
    );
  }

  async function accountOptions(
    actor: TemplateActor,
  ): Promise<TemplateScopeOption[]> {
    if (actor.kind === "account") {
      const acct = await deps.accounts?.getWithCounts(actor.accountId);
      return [{ value: actor.accountId, label: acct?.name ?? actor.accountId }];
    }
    const accounts = (await deps.accounts?.listWithCounts()) ?? [];
    return [
      { value: "", label: "Deployment-wide (all accounts)" },
      ...accounts.map((a) => ({ value: a.id, label: a.name })),
    ];
  }

  function specialtyOptions(): TemplateScopeOption[] {
    return [
      { value: "", label: "All agent types" },
      ...deps.specialtyRegistry
        .listTypes()
        .map((t) => ({ value: t.name, label: t.displayName })),
    ];
  }

  async function renderPage(
    c: Context<AdminUIEnv>,
    actor: TemplateActor,
    scope: Scope,
    flash: { error?: string; notice?: string; status?: number } = {},
  ): Promise<Response> {
    const template = await findTemplate(actor, scope);
    return deps.html(
      renderTemplatesPage({
        userEmail: c.var.userEmail,
        isAdmin: c.var.isAdmin === true,
        ...(deps.settingsNav ? { nav: deps.settingsNav } : {}),
        accountOptions: await accountOptions(actor),
        specialtyOptions: specialtyOptions(),
        accountId: scope.accountId,
        specialty: scope.specialty,
        items: (template?.items ?? []) as TemplateItemRow[],
        templateExists: template !== undefined,
        ...(flash.error ? { error: flash.error } : {}),
        ...(flash.notice ? { notice: flash.notice } : {}),
      }),
      { status: flash.status ?? 200 },
    );
  }

  const field = (form: FormData, name: string) =>
    (form.get(name)?.toString() ?? "").trim();
  const flag = (form: FormData, name: string) => form.get(name) !== null;
  const orNull = (v: string) => (v === "" ? null : v);

  function itemFromForm(form: FormData): TemplateItemInput {
    const kind = field(form, "kind");
    if (!isKind(kind)) throw new ApiError(422, `unknown item kind ${kind}`);
    const key = field(form, "key");
    switch (kind) {
      case "env":
        return {
          kind,
          key,
          // Not trimmed: a value's whitespace is the user's business.
          payload: {
            value: form.get("value")?.toString() ?? "",
            secret: flag(form, "secret"),
          },
        };
      case "tool":
        return { kind, key, payload: { enabled: flag(form, "enabled") } };
      case "plugin":
        return {
          kind,
          key,
          payload: {
            version: orNull(field(form, "version")),
            enabled: flag(form, "enabled"),
          },
        };
      case "cron":
        return {
          kind,
          key,
          payload: {
            schedule: field(form, "schedule"),
            prompt: field(form, "prompt"),
            channel: orNull(field(form, "channel")),
            user: orNull(field(form, "user")),
            preCheck: orNull(field(form, "preCheck")),
            silent: flag(form, "silent"),
            enabled: flag(form, "enabled"),
          },
        };
    }
  }

  /** Runs a mutation; service errors render inline, success redirects. */
  async function mutate(
    c: Context<AdminUIEnv>,
    notice: string,
    run: (actor: TemplateActor, scope: Scope, form: FormData) => Promise<void>,
  ): Promise<Response> {
    let actor: TemplateActor;
    try {
      actor = await resolveActor(c);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      form = new FormData();
    }
    const requested = {
      accountId: field(form, "accountId"),
      specialty: field(form, "specialty"),
    };
    let scope: Scope;
    try {
      scope = resolveScope(actor, requested.accountId, requested.specialty);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      await run(actor, scope, form);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode < 500) {
        return renderPage(c, actor, scope, {
          error: err.message,
          status: err.statusCode,
        });
      }
      throw err;
    }
    const qs = new URLSearchParams({
      ...(scope.accountId !== "" ? { accountId: scope.accountId } : {}),
      ...(scope.specialty !== "" ? { specialty: scope.specialty } : {}),
      notice,
    });
    return c.redirect(`${BASE}?${qs}`, 302);
  }

  app.get(BASE, deps.requireAuth, async (c) => {
    let actor: TemplateActor;
    try {
      actor = await resolveActor(c);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    let scope: Scope;
    try {
      scope = resolveScope(
        actor,
        c.req.query("accountId")?.trim() ?? "",
        c.req.query("specialty")?.trim() ?? "",
      );
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    const key = c.req.query("notice");
    return renderPage(c, actor, scope, {
      ...(key && NOTICES[key] ? { notice: NOTICES[key] } : {}),
    });
  });

  app.post(`${BASE}/items`, deps.requireAuth, (c) =>
    mutate(c, "saved", async (actor, scope, form) => {
      const item = itemFromForm(form);
      const template = await findTemplate(actor, scope);
      if (template) {
        await deps.templateService.putItem(actor, template.id, item);
      } else {
        await deps.templateService.replace(
          actor,
          {
            accountId: scope.accountId === "" ? null : scope.accountId,
            specialty: scope.specialty === "" ? null : scope.specialty,
          },
          [item],
        );
      }
    }),
  );

  app.post(`${BASE}/items/delete`, deps.requireAuth, (c) =>
    mutate(c, "removed", async (actor, scope, form) => {
      const kind = field(form, "kind");
      if (!isKind(kind)) throw new ApiError(422, `unknown item kind ${kind}`);
      const template = await findTemplate(actor, scope);
      if (!template) throw new ApiError(404, "template not found");
      await deps.templateService.deleteItem(
        actor,
        template.id,
        kind,
        field(form, "key"),
      );
    }),
  );

  app.post(`${BASE}/delete`, deps.requireAuth, (c) =>
    mutate(c, "deleted", async (actor, scope) => {
      const template = await findTemplate(actor, scope);
      if (!template) throw new ApiError(404, "template not found");
      await deps.templateService.delete(actor, template.id);
    }),
  );
}
