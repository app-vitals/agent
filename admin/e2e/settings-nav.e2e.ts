/**
 * admin/e2e/settings-nav.e2e.ts
 * Admin UI — settings shell navigation E2E (SGL-2.4)
 *
 * Real browser journeys through the settings layout (sidebar + active pill):
 *   1. Agent detail: click through General, Automation, Configuration, Access
 *      and Extensions; the URL and the aria-current pill follow each click.
 *   2. One write action per section; each POST redirects back to the section
 *      that owns the form.
 *   3. /admin/settings redirects to the first nav item; the Account and
 *      Platform items are reachable from the sidebar.
 *   4. Mobile (375px): the sidebar collapses into a <details> disclosure.
 *
 * Spawns admin/e2e/test-server.ts with ADMIN_E2E_SETTINGS=1 (own port) and
 * mints session cookies directly; no DB or OAuth.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { sign } from "hono/jwt";

const PORT = 3498;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_SECRET = "e2e-admin-test-secret-32chars!!!";
const SESSION_COOKIE = "admin_session";
const AGENT_ID = "agent-e2e-1";
const AGENT_BASE = `/admin/agents/${AGENT_ID}`;

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      ADMIN_E2E_SETTINGS: "1",
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });
  serverProcess.stderr?.on("data", (d: Buffer) => {
    if (d.toString().trim())
      console.error("[admin-e2e-settings-server]", d.toString().trim());
  });
  await waitForServer(`${BASE_URL}/health`, 15_000);
});

test.afterAll(() => {
  serverProcess?.kill("SIGTERM");
  serverProcess = null;
});

async function signIn(context: BrowserContext): Promise<void> {
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
      name: SESSION_COOKIE,
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/** The desktop sidebar's links (the mobile <details> duplicates them). */
const sidebar = (page: Page) => page.locator("nav.settings-sidebar");
const activePill = (page: Page) =>
  sidebar(page).locator('a[aria-current="page"]');

const SECTIONS = [
  { label: "General", path: AGENT_BASE },
  { label: "Automation", path: `${AGENT_BASE}/automation` },
  { label: "Configuration", path: `${AGENT_BASE}/configuration` },
  { label: "Access", path: `${AGENT_BASE}/access` },
  { label: "Extensions", path: `${AGENT_BASE}/extensions` },
];

test.describe("agent detail sections", () => {
  test("sidebar navigation moves the URL and the active pill through all five sections", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.goto(`${BASE_URL}${AGENT_BASE}`);
    await expect(sidebar(page).locator("a.settings-nav-link")).toHaveText(
      SECTIONS.map((s) => s.label),
    );
    await expect(activePill(page)).toHaveText("General");

    for (const s of SECTIONS.slice(1)) {
      await sidebar(page).getByRole("link", { name: s.label }).click();
      await expect(page).toHaveURL(`${BASE_URL}${s.path}`);
      await expect(activePill(page)).toHaveCount(1);
      await expect(activePill(page)).toHaveText(s.label);
      await expect(page.locator("h1")).toContainText("Test Agent");
    }

    // And back to General via the bare agent path.
    await sidebar(page).getByRole("link", { name: "General" }).click();
    await expect(page).toHaveURL(`${BASE_URL}${AGENT_BASE}`);
    await expect(activePill(page)).toHaveText("General");
  });

  test("a write action in each section lands back on that section", async ({
    page,
    context,
  }) => {
    await signIn(context);

    // General: Sync Manifest with a malformed token redirects back with an error.
    await page.goto(`${BASE_URL}${AGENT_BASE}`);
    await page.locator("summary", { hasText: "Sync Manifest" }).click();
    await page.locator('input[name="xoxpToken"]').fill("not-a-slack-token");
    await page.getByRole("button", { name: "Confirm Sync" }).click();
    await page.waitForURL(new RegExp(`${AGENT_BASE}\\?error=`));
    await expect(activePill(page)).toHaveText("General");

    // Automation: add a cron.
    await sidebar(page).getByRole("link", { name: "Automation" }).click();
    await page.locator('input[name="schedule"]').first().fill("5 4 * * *");
    await page
      .locator('form[action$="/crons"] input[name="prompt"]')
      .fill("nightly check");
    await page.getByRole("button", { name: "Add Cron" }).click();
    await page.waitForURL(`${BASE_URL}${AGENT_BASE}/automation`);
    await expect(activePill(page)).toHaveText("Automation");

    // Configuration: set an env var.
    await sidebar(page).getByRole("link", { name: "Configuration" }).click();
    await page
      .locator('form[action$="/envs"] input[name="key"]')
      .fill("E2E_KEY");
    await page
      .locator('form[action$="/envs"] input[name="value"]')
      .fill("e2e-value");
    await page.locator('form[action$="/envs"] button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}${AGENT_BASE}/configuration`);
    await expect(activePill(page)).toHaveText("Configuration");

    // Access: add a review-author allowlist entry.
    await sidebar(page).getByRole("link", { name: "Access" }).click();
    await page
      .locator(
        'form[action$="/review-author-allowlist/add"] input[name="login"]',
      )
      .fill("octocat");
    await page
      .locator('form[action$="/review-author-allowlist/add"] button')
      .click();
    await page.waitForURL(`${BASE_URL}${AGENT_BASE}/access`);
    await expect(activePill(page)).toHaveText("Access");

    // Extensions: add a plugin.
    await sidebar(page).getByRole("link", { name: "Extensions" }).click();
    await page
      .locator("#add-plugin-form input[name='spec']")
      .fill("nav-e2e@seeded-remote");
    await page.locator("#add-plugin-form").getByRole("button").click();
    await page.waitForURL(`${BASE_URL}${AGENT_BASE}/extensions`);
    await expect(activePill(page)).toHaveText("Extensions");
    await expect(page.locator("body")).toContainText("nav-e2e@seeded-remote");
  });
});

test.describe("/admin/settings", () => {
  test("redirects to the first item and moves between Account and Platform items", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.goto(`${BASE_URL}/admin/settings`);
    await expect(page).toHaveURL(`${BASE_URL}/admin/account`);
    await expect(activePill(page)).toHaveText("Account");
    await expect(page.locator("h1")).toHaveText("E2E Account");

    const groups = sidebar(page).locator(".settings-nav-label");
    await expect(groups).toHaveText(["Account", "Platform"]);

    const items = [
      { label: "GitHub Enterprise", path: "/admin/settings/github-enterprise" },
      { label: "Templates", path: "/admin/settings/templates" },
      { label: "Accounts", path: "/admin/accounts" },
      { label: "Account", path: "/admin/account" },
    ];
    for (const item of items) {
      await sidebar(page)
        .getByRole("link", { name: item.label, exact: true })
        .click();
      await expect(page).toHaveURL(`${BASE_URL}${item.path}`);
      await expect(activePill(page)).toHaveCount(1);
      await expect(activePill(page)).toHaveText(item.label);
    }
  });

  test("mobile (375px): sidebar collapses into a disclosure that navigates", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE_URL}/admin/account`);

    const disclosure = page.locator("details.settings-nav-mobile");
    await expect(sidebar(page)).toBeHidden();
    await expect(disclosure).toBeVisible();
    await expect(disclosure.locator("summary")).toHaveText("Account");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(
      disclosure.getByRole("link", { name: "Templates" }),
    ).toBeHidden();

    await disclosure.locator("summary").click();
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(disclosure.locator('a[aria-current="page"]')).toHaveText(
      "Account",
    );

    await disclosure.getByRole("link", { name: "Templates" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/admin/settings/templates`);
    // The new page renders collapsed again, labelled with the active item.
    await expect(
      page.locator("details.settings-nav-mobile summary"),
    ).toHaveText("Templates");
    await expect(
      page.locator("details.settings-nav-mobile"),
    ).not.toHaveAttribute("open", "");
  });

  test("mobile (375px): agent sections are reachable from the disclosure", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE_URL}${AGENT_BASE}`);
    const disclosure = page.locator("details.settings-nav-mobile");
    await expect(disclosure.locator("summary")).toHaveText("General");
    await disclosure.locator("summary").click();
    await disclosure.getByRole("link", { name: "Access" }).click();
    await expect(page).toHaveURL(`${BASE_URL}${AGENT_BASE}/access`);
    await expect(
      page.locator("details.settings-nav-mobile summary"),
    ).toHaveText("Access");
  });
});
