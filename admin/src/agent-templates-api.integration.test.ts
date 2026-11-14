/**
 * admin/src/agent-templates-api.integration.test.ts
 * ATP-1.3: template CRUD authz, validation and env crypto against real
 * Postgres, driven through the /templates app.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentTemplateService } from "./agent-templates.ts";
import { createAgentTemplatesApp } from "./agent-templates-api.ts";
import { parseAdminApiKeys } from "./api-auth.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { SpecialtyTypes } from "./specialty-types.ts";
import { makeStrictTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const KEY = "ab".repeat(32);
const SECRET = "test-session-secret-32-chars-long!!";

describeOrSkip("/templates (integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createAgentTemplatesApp>;
  let accountA: string;
  let accountB: string;
  const crypto = makeStrictTokenCrypto(KEY);
  if (!crypto) throw new Error("test crypto");

  const admin = { Authorization: "Bearer tok-admin" };

  async function cookie(email: string, isAdmin = false) {
    const token = await sign(
      {
        userId: email,
        email,
        isAdmin,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      SECRET,
      "HS256",
    );
    return { Cookie: `admin_session=${token}` };
  }

  function call(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) {
    return app.request(path, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentTemplateItem.deleteMany();
    await prisma.agentTemplate.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.account.deleteMany();
    accountA = (
      await prisma.account.create({ data: { name: "A", maxAgents: 5 } })
    ).id;
    accountB = (
      await prisma.account.create({ data: { name: "B", maxAgents: 5 } })
    ).id;
    const accountByEmail: Record<string, string> = {
      "a@example.com": accountA,
      "b@example.com": accountB,
    };
    app = createAgentTemplatesApp({
      templateService: new AgentTemplateService(
        prisma,
        crypto,
        new SpecialtyTypes({ defaultTypeName: "specialist" }),
      ),
      callerScopeResolver: async (email, isAdmin) =>
        isAdmin
          ? { kind: "all" }
          : {
              kind: "scoped",
              accountId: accountByEmail[email] ?? null,
              agentIds: [],
            },
      sessionSecret: SECRET,
      adminApiKeys: parseAdminApiKeys("root:tok-admin:*,bot:tok-agent:agent-1"),
      agentTokenService: { validate: async () => null },
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  describe("validation", () => {
    it("422 for an unknown specialty", async () => {
      const res = await call("PUT", "/templates", admin, {
        specialty: "nope",
        items: [],
      });
      expect(res.status).toBe(422);
      expect(await prisma.agentTemplate.count()).toBe(0);
    });

    it.each([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "SHIPWRIGHT_TASK_STORE_URL",
      "SHIPWRIGHT_TASK_STORE_TOKEN",
      "gh_token",
    ])("422 for denylisted env key %s", async (key) => {
      const res = await call("PUT", "/templates", admin, {
        items: [{ kind: "env", key, payload: { value: "x" } }],
      });
      expect(res.status).toBe(422);
      expect(await prisma.agentTemplate.count()).toBe(0);
    });

    it("422 for a cron item without a name key", async () => {
      const res = await call("PUT", "/templates", admin, {
        items: [
          {
            kind: "cron",
            key: "  ",
            payload: { schedule: "0 9 * * *", prompt: "brief" },
          },
        ],
      });
      expect(res.status).toBe(422);
    });

    it("422 for a cron item missing schedule or prompt", async () => {
      const res = await call("PUT", "/templates", admin, {
        items: [{ kind: "cron", key: "brief", payload: { prompt: "x" } }],
      });
      expect(res.status).toBe(422);
    });

    it("422 for duplicate keys within a template, accepted across kinds", async () => {
      const cron = {
        kind: "cron",
        key: "brief",
        payload: { schedule: "0 9 * * *", prompt: "brief" },
      };
      const dup = await call("PUT", "/templates", admin, {
        items: [cron, cron],
      });
      expect(dup.status).toBe(422);
      expect(await prisma.agentTemplate.count()).toBe(0);

      const ok = await call("PUT", "/templates", admin, {
        items: [cron, { kind: "tool", key: "brief" }],
      });
      expect(ok.status).toBe(201);
    });

    it("400 for an unknown item kind", async () => {
      const res = await call("PUT", "/templates", admin, {
        items: [{ kind: "bogus", key: "x" }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("crypto and masking", () => {
    it("encrypts env values at rest and masks secrets on GET", async () => {
      const put = await call("PUT", "/templates", admin, {
        specialty: "specialist",
        items: [
          {
            kind: "env",
            key: "LINEAR_API_KEY",
            payload: { value: "lin_secret", secret: true },
          },
          { kind: "env", key: "REGION", payload: { value: "us-east-1" } },
        ],
      });
      expect(put.status).toBe(201);
      const { id } = (await put.json()) as { id: string };

      const rows = await prisma.agentTemplateItem.findMany({
        where: { templateId: id },
        orderBy: { key: "asc" },
      });
      const stored = Object.fromEntries(
        rows.map((r) => [r.key, r.payload as Record<string, unknown>]),
      );
      expect(stored.LINEAR_API_KEY?.value).not.toBe("lin_secret");
      expect(crypto.decrypt(stored.LINEAR_API_KEY?.value as string)).toBe(
        "lin_secret",
      );
      expect(stored.REGION?.value).not.toBe("us-east-1");
      expect(JSON.stringify(rows)).not.toContain("lin_secret");

      const get = await call("GET", `/templates/${id}`, admin);
      const body = (await get.json()) as {
        items: { key: string; payload: Record<string, unknown> }[];
      };
      const byKey = Object.fromEntries(body.items.map((i) => [i.key, i]));
      expect(byKey.LINEAR_API_KEY?.payload).toEqual({
        value: "***",
        secret: true,
      });
      expect(byKey.REGION?.payload.value).toBe("us-east-1");

      const list = await call("GET", "/templates", admin);
      expect(JSON.stringify(await list.json())).not.toContain("lin_secret");
      const put2 = await call("PUT", "/templates", admin, {
        specialty: "specialist",
        items: [
          {
            kind: "env",
            key: "LINEAR_API_KEY",
            payload: { value: "lin_secret_2", secret: true },
          },
        ],
      });
      expect(JSON.stringify(await put2.json())).not.toContain("lin_secret_2");
    });

    it("keeps the stored secret when the mask is sent back", async () => {
      const put = await call("PUT", "/templates", admin, {
        items: [
          {
            kind: "env",
            key: "K",
            payload: { value: "keep-me", secret: true },
          },
        ],
      });
      const { id } = (await put.json()) as { id: string };
      const again = await call("PUT", "/templates", admin, {
        items: [
          { kind: "env", key: "K", payload: { value: "***", secret: true } },
        ],
      });
      expect(again.status).toBe(200);
      const row = await prisma.agentTemplateItem.findFirstOrThrow({
        where: { templateId: id, key: "K" },
      });
      expect(crypto.decrypt((row.payload as { value: string }).value)).toBe(
        "keep-me",
      );

      const bad = await call("PUT", "/templates", admin, {
        items: [
          { kind: "env", key: "NEW", payload: { value: "***", secret: true } },
        ],
      });
      expect(bad.status).toBe(422);
    });
  });

  describe("CRUD", () => {
    it("create then replace one scope, list with filters, item ops, delete", async () => {
      const first = await call("PUT", "/templates", admin, {
        accountId: accountA,
        specialty: "specialist",
        items: [{ kind: "tool", key: "Bash" }],
      });
      expect(first.status).toBe(201);
      const { id } = (await first.json()) as { id: string };

      const second = await call("PUT", "/templates", admin, {
        accountId: accountA,
        specialty: "specialist",
        items: [
          { kind: "plugin", key: "shipwright@app-vitals/shipwright" },
          {
            kind: "cron",
            key: "brief",
            payload: { schedule: "0 9 * * *", prompt: "go" },
          },
        ],
      });
      expect(second.status).toBe(200);
      const replaced = (await second.json()) as {
        id: string;
        items: { kind: string; key: string }[];
      };
      expect(replaced.id).toBe(id);
      expect(replaced.items.map((i) => i.kind)).toEqual(["cron", "plugin"]);
      expect(await prisma.agentTemplate.count()).toBe(1);

      await call("PUT", "/templates", admin, { items: [] }); // deployment-wide
      const all = (await (await call("GET", "/templates", admin)).json()) as {
        templates: unknown[];
      };
      expect(all.templates).toHaveLength(2);
      const filtered = (await (
        await call("GET", `/templates?accountId=${accountA}`, admin)
      ).json()) as { templates: unknown[] };
      expect(filtered.templates).toHaveLength(1);

      const added = await call("PUT", `/templates/${id}/items`, admin, {
        kind: "env",
        key: "REGION",
        payload: { value: "eu" },
      });
      expect(added.status).toBe(200);
      expect(
        await prisma.agentTemplateItem.count({ where: { templateId: id } }),
      ).toBe(3);

      const del = await call(
        "DELETE",
        `/templates/${id}/items?kind=plugin&key=${encodeURIComponent("shipwright@app-vitals/shipwright")}`,
        admin,
      );
      expect(del.status).toBe(204);
      const missing = await call(
        "DELETE",
        `/templates/${id}/items?kind=plugin&key=nope`,
        admin,
      );
      expect(missing.status).toBe(404);

      expect((await call("DELETE", `/templates/${id}`, admin)).status).toBe(
        204,
      );
      expect(
        await prisma.agentTemplateItem.count({ where: { templateId: id } }),
      ).toBe(0);
      expect((await call("GET", `/templates/${id}`, admin)).status).toBe(404);
    });
  });

  describe("authz", () => {
    it("account caller defaults to and manages only its own account", async () => {
      const h = await cookie("a@example.com");
      const put = await call("PUT", "/templates", h, {
        items: [{ kind: "tool", key: "Bash" }],
      });
      expect(put.status).toBe(201);
      const t = (await put.json()) as { id: string; accountId: string };
      expect(t.accountId).toBe(accountA);

      expect((await call("GET", `/templates/${t.id}`, h)).status).toBe(200);
      const list = (await (await call("GET", "/templates", h)).json()) as {
        templates: unknown[];
      };
      expect(list.templates).toHaveLength(1);
    });

    it("cross-account and deployment-wide access is refused", async () => {
      const aTemplate = (await (
        await call("PUT", "/templates", admin, {
          accountId: accountA,
          items: [],
        })
      ).json()) as { id: string };
      const global = (await (
        await call("PUT", "/templates", admin, { items: [] })
      ).json()) as { id: string };
      const b = await cookie("b@example.com");

      // Reading/changing another account's or a global template: 404 (no leak).
      for (const id of [aTemplate.id, global.id]) {
        expect((await call("GET", `/templates/${id}`, b)).status).toBe(404);
        expect((await call("DELETE", `/templates/${id}`, b)).status).toBe(404);
        expect(
          (
            await call("PUT", `/templates/${id}/items`, b, {
              kind: "tool",
              key: "Bash",
            })
          ).status,
        ).toBe(404);
        expect(
          (await call("DELETE", `/templates/${id}/items?kind=tool&key=x`, b))
            .status,
        ).toBe(404);
      }
      expect(await prisma.agentTemplate.count()).toBe(2);

      // Naming another account or the deployment scope: 403.
      expect(
        (await call("PUT", "/templates", b, { accountId: accountA, items: [] }))
          .status,
      ).toBe(403);
      expect(
        (await call("PUT", "/templates", b, { accountId: null, items: [] }))
          .status,
      ).toBe(403);
      expect(
        (await call("GET", `/templates?accountId=${accountA}`, b)).status,
      ).toBe(403);

      // The list never includes others' templates.
      const list = (await (await call("GET", "/templates", b)).json()) as {
        templates: unknown[];
      };
      expect(list.templates).toEqual([]);
    });

    it("403 for callers without an account, agent keys and non-scoped sessions", async () => {
      expect(
        (await call("GET", "/templates", await cookie("nobody@example.com")))
          .status,
      ).toBe(403);
      expect(
        (await call("GET", "/templates", { Authorization: "Bearer tok-agent" }))
          .status,
      ).toBe(403);
      expect((await call("GET", "/templates", {})).status).toBe(401);
    });

    it("an admin session manages deployment-wide templates", async () => {
      const h = await cookie("root@example.com", true);
      const res = await call("PUT", "/templates", h, { items: [] });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { accountId: null }).accountId).toBeNull();
    });
  });
});
