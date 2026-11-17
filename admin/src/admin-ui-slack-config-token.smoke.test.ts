/**
 * admin/src/admin-ui-slack-config-token.smoke.test.ts
 * SCT-4.1: the create / connect-slack / sync-manifest / delete flows use a
 * stored Slack config token (minted via the resolver) when no xoxpToken is
 * pasted; a pasted token wins; with neither, behavior is unchanged.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_ID,
  BASE_SLACK_CLIENT,
  makeMockDeps,
  makeSessionCookie,
} from "./admin-ui.fixtures.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import {
  isSlackConfigTokenRevokedError,
  type SlackConfigTokenResolver,
} from "./slack-config-token.ts";
import { resolveDefaultSpecialtyName } from "./specialty-types.ts";

/** Resolver double: `scopes` are the rows that exist; mints sequential tokens. */
function makeResolver(scopes: Array<string | null>) {
  const mintedFor: Array<string | null> = [];
  let n = 0;
  const resolver = {
    get: async (a: string | null) =>
      scopes.includes(a) ? { accountId: a } : null,
    resolveForAccount: async (a: string) =>
      scopes.includes(a)
        ? { accountId: a }
        : scopes.includes(null)
          ? { accountId: null }
          : null,
    withSlackConfigAccessToken: async <T>(
      scope: string | null,
      fn: (t: string) => Promise<T>,
    ) => {
      mintedFor.push(scope);
      try {
        return await fn(`minted-${++n}`);
      } catch (err) {
        if (!isSlackConfigTokenRevokedError(err)) throw err;
        mintedFor.push(scope);
        return fn(`minted-${++n}`);
      }
    },
  } as unknown as SlackConfigTokenResolver;
  return { resolver, mintedFor };
}

const agentIn = (accountId: string | null) => ({
  id: AGENT_ID,
  name: "Test Agent",
  accountId,
  slackId: "U123456",
  selfHosted: false,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  repos: [],
  reviewAuthorAllowlist: [],
  patchAuthorAllowlist: [],
  restrictSlackToMembers: false,
  specialty: "coding",
  missingRequiredEnv: [],
});

function agentServiceIn(accountId: string | null) {
  const base = makeMockDeps().agentService;
  return {
    ...base,
    getDetail: async () => agentIn(accountId),
  } as unknown as ReturnType<typeof makeMockDeps>["agentService"];
}

describe("admin UI — stored Slack config token flows", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  const post = (
    app: ReturnType<typeof createAdminUIApp>,
    path: string,
    fields: Record<string, string>,
  ) =>
    app.request(path, {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
      redirect: "manual",
    });

  const syncDeps = (
    tokens: string[],
    opts: { rejectFirst?: boolean; accountId?: string | null } = {},
  ) => ({
    agentService: agentServiceIn(opts.accountId ?? null),
    agentEnvService: {
      getByAgentId: async () => ({ env: {}, secretKeys: [] }),
      upsert: async () => {},
      patch: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => ({
        env: { SLACK_APP_ID: "A123456" },
        agentId: AGENT_ID,
        allowedTools: [],
      }),
    },
    slackClient: {
      updateAppManifest: async (token: string) => {
        tokens.push(token);
        if (opts.rejectFirst && tokens.length === 1) {
          throw new Error("Slack apps.manifest.update failed: token_revoked");
        }
      },
    },
  });

  // ── sync-manifest ──────────────────────────────────────────────────────────

  it("sync-manifest: stored token, nothing pasted → syncs with a minted token", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({ ...syncDeps(tokens), slackConfigTokens: resolver }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/sync-manifest`, {});
    expect(res.headers.get("location")).toContain("success=manifest_synced");
    expect(tokens).toEqual(["minted-1"]);
  });

  it("sync-manifest: account row overrides the default row", async () => {
    const tokens: string[] = [];
    const { resolver, mintedFor } = makeResolver([null, "acct-1"]);
    const app = createAdminUIApp(
      makeMockDeps({
        ...syncDeps(tokens, { accountId: "acct-1" }),
        slackConfigTokens: resolver,
      }),
    );
    await post(app, `/admin/agents/${AGENT_ID}/sync-manifest`, {});
    expect(mintedFor).toEqual(["acct-1"]);
  });

  it("sync-manifest: a pasted token wins over the stored one", async () => {
    const tokens: string[] = [];
    const { resolver, mintedFor } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({ ...syncDeps(tokens), slackConfigTokens: resolver }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/sync-manifest`, {
      xoxpToken: "xoxe.xoxp-1-pasted",
    });
    expect(res.headers.get("location")).toContain("success=manifest_synced");
    expect(tokens).toEqual(["xoxe.xoxp-1-pasted"]);
    expect(mintedFor).toEqual([]);
  });

  it("sync-manifest: a pasted token with a bad prefix is still rejected when a stored token exists", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({ ...syncDeps(tokens), slackConfigTokens: resolver }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/sync-manifest`, {
      xoxpToken: "xoxb-nope",
    });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "must start with xoxe.xoxp-",
    );
    expect(tokens).toEqual([]);
  });

  it("sync-manifest: neither pasted nor stored → today's prefix error", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([]);
    const app = createAdminUIApp(
      makeMockDeps({ ...syncDeps(tokens), slackConfigTokens: resolver }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/sync-manifest`, {});
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "must start with xoxe.xoxp-",
    );
    expect(tokens).toEqual([]);
  });

  it("sync-manifest: token_revoked → one forced rotate + retry succeeds", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({
        ...syncDeps(tokens, { rejectFirst: true }),
        slackConfigTokens: resolver,
      }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/sync-manifest`, {});
    expect(res.headers.get("location")).toContain("success=manifest_synced");
    expect(tokens).toEqual(["minted-1", "minted-2"]);
  });

  // ── connect-slack ──────────────────────────────────────────────────────────

  const connectDeps = (tokens: string[], rejectFirst = false) => ({
    agentService: agentServiceIn(null),
    slackClient: {
      createAppManifest: async (token: string, m: unknown) => {
        tokens.push(token);
        if (rejectFirst && tokens.length === 1) {
          throw new Error("Slack apps.manifest.create failed: invalid_auth");
        }
        return BASE_SLACK_CLIENT.createAppManifest(token, m as never);
      },
    },
  });

  it("connect-slack: stored token, nothing pasted → redirects to Slack OAuth", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({ ...connectDeps(tokens), slackConfigTokens: resolver }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/connect-slack`, {});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("slack.com/oauth");
    expect(res.headers.get("set-cookie")).toContain("slack_provision_state=");
    expect(tokens).toEqual(["minted-1"]);
  });

  it("connect-slack: a pasted token wins", async () => {
    const tokens: string[] = [];
    const { resolver, mintedFor } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({ ...connectDeps(tokens), slackConfigTokens: resolver }),
    );
    await post(app, `/admin/agents/${AGENT_ID}/connect-slack`, {
      xoxpToken: "xoxe.xoxp-1-pasted",
    });
    expect(tokens).toEqual(["xoxe.xoxp-1-pasted"]);
    expect(mintedFor).toEqual([]);
  });

  it("connect-slack: neither pasted nor stored → error redirect, no Slack call", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([]);
    const app = createAdminUIApp(
      makeMockDeps({ ...connectDeps(tokens), slackConfigTokens: resolver }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/connect-slack`, {});
    expect(res.headers.get("location")).toContain("error=");
    expect(tokens).toEqual([]);
  });

  it("connect-slack: invalid_auth → one forced rotate + retry succeeds", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({
        ...connectDeps(tokens, true),
        slackConfigTokens: resolver,
      }),
    );
    const res = await post(app, `/admin/agents/${AGENT_ID}/connect-slack`, {});
    expect(res.headers.get("location")).toContain("slack.com/oauth");
    expect(tokens).toEqual(["minted-1", "minted-2"]);
  });

  // ── create agent (inline connect Slack) ────────────────────────────────────

  const createDeps = (tokens: string[]) => {
    const base = makeMockDeps();
    return {
      ...connectDeps(tokens),
      provisioner: { ...base.provisioner, canProvision: true },
    };
  };
  const createForm = (extra: Record<string, string> = {}) => ({
    name: "new-agent",
    type: resolveDefaultSpecialtyName(),
    runtime: "in-cluster",
    connectSlack: "true",
    ...extra,
  });

  it("create agent: connectSlack with a stored token and no paste → Slack OAuth via a minted token", async () => {
    const tokens: string[] = [];
    const { resolver } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({ ...createDeps(tokens), slackConfigTokens: resolver }),
    );
    const res = await post(app, "/admin/agents", createForm());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("slack.com/oauth");
    expect(tokens).toEqual(["minted-1"]);
  });

  it("create agent: a pasted token wins over the stored one", async () => {
    const tokens: string[] = [];
    const { resolver, mintedFor } = makeResolver([null]);
    const app = createAdminUIApp(
      makeMockDeps({ ...createDeps(tokens), slackConfigTokens: resolver }),
    );
    await post(
      app,
      "/admin/agents",
      createForm({ xoxpToken: "xoxe.xoxp-1-p" }),
    );
    expect(tokens).toEqual(["xoxe.xoxp-1-p"]);
    expect(mintedFor).toEqual([]);
  });

  it("create agent: neither pasted nor stored → error redirect, no Slack call", async () => {
    const tokens: string[] = [];
    const app = createAdminUIApp(makeMockDeps(createDeps(tokens)));
    const res = await post(app, "/admin/agents", createForm());
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "must start with xoxe.xoxp-",
    );
    expect(tokens).toEqual([]);
  });

  // ── hints / optional field ─────────────────────────────────────────────────

  it("agent page: Sync Manifest field is required without a stored token, optional with one", async () => {
    const get = async (slackConfigTokens?: SlackConfigTokenResolver) => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentService: agentServiceIn(null),
          ...(slackConfigTokens ? { slackConfigTokens } : {}),
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      return res.text();
    };
    const without = await get();
    expect(without).toMatch(/name="xoxpToken"[^>]*required/);
    const withStored = await get(makeResolver([null]).resolver);
    expect(withStored).not.toMatch(/name="xoxpToken"[^>]*required/);
    expect(withStored).toContain("Optional");
  });
});
