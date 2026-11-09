/**
 * admin/e2e/marketplaces-section.e2e.ts
 * Admin UI — Marketplaces section on the agent page (PMK-1.5)
 *
 * Covers: remote rows listed, add and remove of a remote row, and baked rows
 * (reported by the runtime) rendered read-only with no controls.
 *
 * Spawns admin/e2e/test-server.ts on its own port; the server's marketplace
 * rows are in memory, so tests run serially against one server.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { sign } from "hono/jwt";

const PORT = 3496;
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
      console.error("[admin-e2e-marketplaces-server]", d.toString().trim());
  });
  await waitForServer(`${BASE_URL}/health`, 15_000);
});

test.afterAll(() => {
  serverProcess?.kill("SIGTERM");
  serverProcess = null;
});

const table = (page: Page) => page.locator("#marketplaces-table");

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
  await page.goto(`${BASE_URL}/admin/agents/${AGENT_ID}`);
  await openGroup(page);
}

// The section lives in the "Plugins & Tools" accordion group, collapsed on
// every page load (including the redirect after each add/remove).
async function openGroup(page: Page) {
  // Set `open` rather than clicking the summary, so a still-old (already
  // open) page can't be toggled shut; the table locator retries across the
  // navigation.
  await expect(async () => {
    await page
      .locator("details", { has: page.locator("#marketplaces-table") })
      .evaluate((el) => {
        (el as HTMLDetailsElement).open = true;
      });
    await expect(table(page)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test("lists the remote row with source and ref, and the baked row", async ({
  page,
  context,
}) => {
  await loadAgentPage(page, context);
  const remote = table(page).locator("tbody tr", { hasText: "seeded-remote" });
  await expect(remote).toContainText("app-vitals/seeded");
  await expect(remote).toContainText("v1.2.3");
  await expect(remote).toContainText("remote");
  await expect(
    table(page).locator('tr[data-baked-marketplace="baked-e2e"]'),
  ).toContainText("from image");
});

test("baked rows have no controls", async ({ page, context }) => {
  await loadAgentPage(page, context);
  const baked = table(page).locator('tr[data-baked-marketplace="baked-e2e"]');
  await expect(baked).toHaveCount(1);
  await expect(baked.locator("form, button, input, a")).toHaveCount(0);
});

test("adds a remote row and then removes it", async ({ page, context }) => {
  await loadAgentPage(page, context);
  const form = page.locator("#add-marketplace-form");
  await form.locator('input[name="name"]').fill("added-remote");
  await form.locator('input[name="source"]').fill("owner/added");
  await form.locator('input[name="ref"]').fill("main");
  await form.getByRole("button", { name: "Add marketplace" }).click();
  await page.waitForURL(`${BASE_URL}/admin/agents/${AGENT_ID}`);
  await openGroup(page);

  const added = table(page).locator("tbody tr", { hasText: "added-remote" });
  await expect(added).toContainText("owner/added");
  await expect(added).toContainText("main");

  await added.getByRole("button", { name: "Remove" }).click();
  await page.waitForURL(`${BASE_URL}/admin/agents/${AGENT_ID}`);
  await openGroup(page);
  await expect(
    table(page).locator("tbody tr", { hasText: "added-remote" }),
  ).toHaveCount(0);
  // The seeded row and the baked row are untouched.
  await expect(
    table(page).locator("tbody tr", { hasText: "seeded-remote" }),
  ).toHaveCount(1);
  await expect(table(page).locator("tr[data-baked-marketplace]")).toHaveCount(
    1,
  );
});
