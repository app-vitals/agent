/**
 * admin/e2e/plugins-section.e2e.ts
 * Admin UI — Plugins card add/remove on the agent Extensions section (/admin/agents/:id/extensions) (PUI-1.2)
 *
 * Covers: seeded row listed, add by spec (explicit and bare), malformed spec
 * error, and remove.
 *
 * Spawns admin/e2e/test-server.ts on its own port; the server's plugin
 * rows are in memory, so tests run serially against one server.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { sign } from "hono/jwt";

const PORT = 3497;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_SECRET = "e2e-admin-test-secret-32chars!!!";
const AGENT_ID = "agent-e2e-1";

const __dirname = dirname(fileURLToPath(import.meta.url));

test.describe.configure({ mode: "serial" });

let serverProcess: ChildProcess | null = null;

async function waitForServer(url: string, maxWaitMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start within ${maxWaitMs}ms`);
}

test.beforeAll(async () => {
  serverProcess = spawn("bun", ["run", resolve(__dirname, "test-server.ts")], {
    env: {
      ...process.env,
      ADMIN_E2E_PORT: String(PORT),
      ADMIN_E2E_SESSION_SECRET: SESSION_SECRET,
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });
  serverProcess.stderr?.on("data", (d: Buffer) => {
    if (d.toString().trim())
      console.error("[admin-e2e-plugins-server]", d.toString().trim());
  });
  await waitForServer(`${BASE_URL}/health`, 15_000);
});

test.afterAll(() => {
  serverProcess?.kill("SIGTERM");
  serverProcess = null;
});

const table = (page: Page) => page.locator("#plugins-table");

async function loadAgentPage(page: Page, context: BrowserContext) {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      userId: "google-sub-e2e",
      email: "admin@example.com",
      isAdmin: true,
      iat: nowSec,
      exp: nowSec + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
  await context.addCookies([
    {
      name: "admin_session",
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(`${BASE_URL}/admin/agents/${AGENT_ID}/extensions`);
}

test("lists the seeded plugin", async ({ page, context }) => {
  await loadAgentPage(page, context);
  await expect(
    table(page).locator("tbody tr", { hasText: "seeded-plugin@seeded-remote" }),
  ).toHaveCount(1);
});

test("adds a plugin by spec and then removes it", async ({ page, context }) => {
  await loadAgentPage(page, context);
  const form = page.locator("#add-plugin-form");
  await form.locator('input[name="spec"]').fill("added@seeded-remote");
  await form.getByRole("button", { name: "Add plugin" }).click();
  await page.waitForURL(`${BASE_URL}/admin/agents/${AGENT_ID}/extensions`);

  const added = table(page).locator("tbody tr", {
    hasText: "added@seeded-remote",
  });
  await expect(added).toHaveCount(1);

  await added.getByRole("button", { name: "Remove" }).click();
  await page.waitForURL(`${BASE_URL}/admin/agents/${AGENT_ID}/extensions`);
  await expect(
    table(page).locator("tbody tr", { hasText: "added@seeded-remote" }),
  ).toHaveCount(0);
  await expect(
    table(page).locator("tbody tr", { hasText: "seeded-plugin" }),
  ).toHaveCount(1);
});

test("a bare name defaults to the shipwright marketplace", async ({
  page,
  context,
}) => {
  await loadAgentPage(page, context);
  const form = page.locator("#add-plugin-form");
  await form.locator('input[name="spec"]').fill("barename");
  await form.getByRole("button", { name: "Add plugin" }).click();
  await page.waitForURL(`${BASE_URL}/admin/agents/${AGENT_ID}/extensions`);
  await expect(
    table(page).locator("tbody tr", { hasText: "barename@shipwright" }),
  ).toHaveCount(1);
});

test("a malformed spec redirects with an error and adds nothing", async ({
  page,
  context,
}) => {
  await loadAgentPage(page, context);
  const before = await table(page).locator("tbody tr").count();
  const form = page.locator("#add-plugin-form");
  await form.locator('input[name="spec"]').fill("a@b@c");
  await form.getByRole("button", { name: "Add plugin" }).click();
  await page.waitForURL(/\?error=/);
  await expect(table(page).locator("tbody tr")).toHaveCount(before);
});

test("settings content grows with the viewport width", async ({
  page,
  context,
}) => {
  const contentWidth = async () =>
    (await page.locator(".settings-content").boundingBox())?.width ?? 0;
  await page.setViewportSize({ width: 1200, height: 900 });
  await loadAgentPage(page, context);
  const narrow = await contentWidth();
  await page.setViewportSize({ width: 1800, height: 900 });
  const wide = await contentWidth();
  expect(wide).toBeGreaterThan(narrow);
});
