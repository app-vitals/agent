/**
 * admin/src/admin-ui-slack-config-token.ts
 * GET/POST /admin/settings/slack-config-token — Settings > Slack config token
 * (SCT-3.1). A thin UI over SlackConfigTokenService, scoped like the Templates
 * editor: platform admins manage the deployment-wide row and any account's row
 * (?accountId=); account owners manage only their own account's row; plain
 * members, ownerless callers and other accounts get 403.
 *
 * Neither the rendered HTML nor any redirect URL carries token material: the
 * pasted refresh token is validated by rotating it once, the rotated pair goes
 * straight to the service, and only metadata is read back.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { accountIdFromScope } from "./account-agent-create.ts";
import type { AccountMemberService } from "./account-members.ts";
import type { AccountService } from "./accounts.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import type { SettingsNav } from "./admin-ui-settings-layout.ts";
import {
  ADMIN_SLACK_CONFIG_TOKEN_PATH as BASE,
  renderSlackConfigTokenPage,
  type SlackConfigTokenScopeOption,
} from "./admin-ui-slack-config-token-pages.ts";
import type { CallerScopeResolver } from "./caller-scope.ts";
import {
  ApiError,
  ForbiddenError,
  UnprocessableEntityError,
} from "./errors.ts";
import type { SlackConfigTokenService } from "./slack-config-token.ts";
import type { SlackConfigTokenClient } from "./slack-provisioning-client.ts";

export interface AdminSlackConfigTokenRouteDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  tokens: Pick<
    SlackConfigTokenService,
    "get" | "save" | "clear" | "getAccessToken"
  >;
  /** tooling.tokens.rotate client, used to validate a pasted refresh token. */
  rotateClient: SlackConfigTokenClient;
  /** SHIPWRIGHT_ENCRYPTION_KEY is configured; save is refused without it. */
  encryptionConfigured: () => boolean;
  callerScopeResolver: CallerScopeResolver;
  /** Needed to tell account owners from plain members; absent = admins only. */
  members?: Pick<AccountMemberService, "getByEmail">;
  accounts?: Pick<AccountService, "listWithCounts" | "getWithCounts">;
  settingsNav?: SettingsNav;
  html: (content: string, opts?: { status?: number }) => Response;
}

type Actor = { kind: "admin" } | { kind: "account"; accountId: string };

const NOTICES: Record<string, string> = {
  saved: "Slack config token validated and saved.",
  cleared: "Slack config token cleared.",
  rotated: "Slack config token rotated.",
};

const REFRESH_PREFIX = "xoxe-1-";

export function registerAdminSlackConfigTokenRoutes(
  app: Hono<AdminUIEnv>,
  deps: AdminSlackConfigTokenRouteDeps,
): void {
  async function resolveActor(c: Context<AdminUIEnv>): Promise<Actor> {
    if (c.var.isAdmin === true) return { kind: "admin" };
    const accountId = accountIdFromScope(
      await deps.callerScopeResolver(c.var.userEmail, false),
    );
    if (accountId === null || !deps.members) {
      throw new ForbiddenError("Admin or account owner access required");
    }
    const me = await deps.members.getByEmail(c.var.userEmail);
    if (!me || me.role !== "owner" || me.accountId !== accountId) {
      throw new ForbiddenError("Admin or account owner access required");
    }
    return { kind: "account", accountId };
  }

  /** Returns the account id to act on (null = deployment-wide); 403 otherwise. */
  function resolveScope(actor: Actor, requested: string): string | null {
    if (actor.kind === "account") {
      if (requested !== "" && requested !== actor.accountId) {
        throw new ForbiddenError(
          "cannot manage another account's or the deployment-wide Slack config token",
        );
      }
      return actor.accountId;
    }
    return requested === "" ? null : requested;
  }

  async function accountOptions(
    actor: Actor,
  ): Promise<SlackConfigTokenScopeOption[]> {
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

  async function renderPage(
    c: Context<AdminUIEnv>,
    actor: Actor,
    accountId: string | null,
    flash: { error?: string; notice?: string; status?: number } = {},
  ): Promise<Response> {
    const row = await deps.tokens.get(accountId);
    return deps.html(
      renderSlackConfigTokenPage({
        userEmail: c.var.userEmail,
        isAdmin: c.var.isAdmin === true,
        ...(deps.settingsNav ? { nav: deps.settingsNav } : {}),
        accountOptions: await accountOptions(actor),
        accountId: accountId ?? "",
        status: row
          ? {
              lastRotatedAt: row.lastRotatedAt,
              lastError: row.lastError,
              slackTeamId: row.slackTeamId,
              slackUserId: row.slackUserId,
            }
          : null,
        encryptionConfigured: deps.encryptionConfigured(),
        ...(flash.error ? { error: flash.error } : {}),
        ...(flash.notice ? { notice: flash.notice } : {}),
      }),
      { status: flash.status ?? 200 },
    );
  }

  /** Slack's own error code, if it is a safe identifier; never a message. */
  function rotateFailure(err: unknown): ApiError {
    const code = (err as { code?: unknown } | null)?.code;
    const safe =
      typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code)
        ? code
        : "unknown_error";
    return new UnprocessableEntityError(
      `Slack rejected the refresh token (${safe}). Nothing was saved.`,
    );
  }

  async function mutate(
    c: Context<AdminUIEnv>,
    notice: string,
    run: (accountId: string | null, form: FormData) => Promise<void>,
  ): Promise<Response> {
    let actor: Actor;
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
    let accountId: string | null;
    try {
      accountId = resolveScope(
        actor,
        (form.get("accountId")?.toString() ?? "").trim(),
      );
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      await run(accountId, form);
    } catch (err) {
      if (err instanceof ApiError) {
        return renderPage(c, actor, accountId, {
          error: err.message,
          status: err.statusCode,
        });
      }
      throw err;
    }
    const qs = new URLSearchParams({
      ...(accountId !== null ? { accountId } : {}),
      notice,
    });
    return c.redirect(`${BASE}?${qs}`, 302);
  }

  app.get(BASE, deps.requireAuth, async (c) => {
    let actor: Actor;
    let accountId: string | null;
    try {
      actor = await resolveActor(c);
      accountId = resolveScope(actor, c.req.query("accountId")?.trim() ?? "");
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    const key = c.req.query("notice");
    return renderPage(c, actor, accountId, {
      ...(key && NOTICES[key] ? { notice: NOTICES[key] } : {}),
    });
  });

  app.post(`${BASE}/save`, deps.requireAuth, (c) =>
    mutate(c, "saved", async (accountId, form) => {
      if (!deps.encryptionConfigured()) {
        throw new UnprocessableEntityError(
          "SHIPWRIGHT_ENCRYPTION_KEY is not configured; refusing to store a Slack config token unencrypted. Set it to a 64-character hex string (openssl rand -hex 32) and retry.",
        );
      }
      const pasted = (form.get("refreshToken")?.toString() ?? "").trim();
      if (!pasted.startsWith(REFRESH_PREFIX)) {
        throw new UnprocessableEntityError(
          `Paste a Slack App Configuration refresh token (it starts with ${REFRESH_PREFIX}).`,
        );
      }
      let rotated: Awaited<
        ReturnType<SlackConfigTokenClient["rotateConfigToken"]>
      >;
      try {
        rotated = await deps.rotateClient.rotateConfigToken(pasted);
      } catch (err) {
        throw rotateFailure(err);
      }
      await deps.tokens.save(accountId, {
        refreshToken: rotated.refreshToken,
        accessToken: rotated.accessToken,
        accessTokenExpiresAt: new Date(rotated.exp * 1000),
        slackTeamId: rotated.teamId,
        slackUserId: rotated.userId,
      });
    }),
  );

  app.post(`${BASE}/clear`, deps.requireAuth, (c) =>
    mutate(c, "cleared", async (accountId) => {
      await deps.tokens.clear(accountId);
    }),
  );

  app.post(`${BASE}/rotate`, deps.requireAuth, (c) =>
    mutate(c, "rotated", async (accountId) => {
      await deps.tokens.getAccessToken(accountId, { forceRotate: true });
    }),
  );
}
