/**
 * admin/src/admin-ui-github-enterprise-pages.unit.test.ts
 * Pure render tests for the enterprise GitHub apps settings page (GHE-1.4):
 * empty, configured, validation-failed, and the never-render-the-key rule.
 */

import { describe, expect, test } from "bun:test";
import { runWithSettingsNav } from "./admin-ui-account-nav.ts";
import {
  type GheApp,
  renderGithubEnterpriseSettingsPage,
} from "./admin-ui-github-enterprise-pages.ts";
import { renderAdminToolbar } from "./admin-ui-styles.ts";

const PEM_MARKER = "-----BEGIN PRIVATE KEY-----";

function app(over: Partial<GheApp> = {}): GheApp {
  return {
    role: "installer",
    appId: "12345",
    slug: "acme-installer",
    enterpriseSlug: "acme",
    keySet: true,
    lastValidationStatus: "valid",
    lastValidatedAt: "2026-11-09T12:00:00.000Z",
    lastValidationError: null,
    createdAt: "2026-11-09T11:00:00.000Z",
    updatedAt: "2026-11-09T11:00:00.000Z",
    ...over,
  };
}

const base = { userEmail: "admin@x.com" };
const empty = { configured: false, installer: null, lookup: null };

describe("renderGithubEnterpriseSettingsPage", () => {
  test("empty state explains the feature is optional and shows both paste forms", () => {
    const html = renderGithubEnterpriseSettingsPage({ ...base, status: empty });
    expect(html).toContain("optional");
    expect(html).toContain("Installer app");
    expect(html).toContain("Lookup app");
    expect(html).toContain(
      'action="/admin/settings/github-enterprise/apps/installer"',
    );
    expect(html).toContain(
      'action="/admin/settings/github-enterprise/apps/lookup"',
    );
    expect(html).toContain('name="enterpriseSlug"');
    expect(html).toContain('name="privateKey"');
    expect(html).not.toContain("/validate");
    expect(html).not.toContain("Organizations</div>");
  });

  test("only the installer form asks for an enterprise slug", () => {
    const html = renderGithubEnterpriseSettingsPage({ ...base, status: empty });
    expect(html.match(/name="enterpriseSlug"/g)?.length).toBe(1);
  });

  test("configured card shows status only: key set, result, time, no key", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      status: { configured: true, installer: app(), lookup: null },
    });
    expect(html).toContain("acme-installer");
    expect(html).toContain("12345");
    expect(html).toContain("Key set");
    expect(html).toContain("valid");
    expect(html).toContain("2026-11-09 12:00");
    expect(html).toContain("/apps/installer/validate");
    expect(html).toContain("/apps/installer/delete");
    expect(html).not.toContain(PEM_MARKER);
    expect(html).not.toContain('type="password" value=');
    expect(html).not.toMatch(/<textarea[^>]*>[^<]+<\/textarea>/);
  });

  test("never-validated app says so", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      status: {
        configured: true,
        installer: app({ lastValidationStatus: null, lastValidatedAt: null }),
        lookup: null,
      },
    });
    expect(html).toContain("Not validated yet");
  });

  test("validation failure renders the stored error, escaped", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      status: {
        configured: true,
        installer: app({
          lastValidationStatus: "missing_permission",
          lastValidationError: "the App does not hold <b>x</b>",
        }),
        lookup: null,
      },
    });
    expect(html).toContain("missing_permission");
    expect(html).toContain("the App does not hold &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  test("warnings render on the matching card only, as non-error notes", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      status: { configured: true, installer: app(), lookup: app({ role: "lookup", enterpriseSlug: null }) },
      warnings: ["installer_repositories_write"],
    });
    expect(html).toContain("enterprise_organization_installation_repositories");
    expect(html.match(/gh-ent-warning/g)?.length).toBe(1);
    expect(html).not.toContain("Organization Members");
  });

  test("unknown warning codes are ignored", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      status: { configured: true, installer: app(), lookup: null },
      warnings: ["<script>alert(1)</script>"],
    });
    expect(html).not.toContain("gh-ent-warning");
    expect(html).not.toContain("<script>alert");
  });

  test("key not set shows 'Key not set'", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      status: {
        configured: true,
        installer: app({ keySet: false }),
        lookup: null,
      },
    });
    expect(html).toContain("Key not set");
  });

  test("org list renders install actions and lookup state", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      agentId: "agent-1",
      status: {
        configured: true,
        installer: app(),
        lookup: app({
          role: "lookup",
          slug: "acme-lookup",
          enterpriseSlug: null,
        }),
      },
      orgs: {
        configured: true,
        agentAppSlug: "agent-app",
        orgs: [
          {
            id: 1,
            login: "org-a",
            lookupAppInstalled: false,
            agentAppInstalled: false,
          },
          {
            id: 2,
            login: "org-b",
            lookupAppInstalled: true,
            agentAppInstalled: true,
          },
        ],
      },
    });
    expect(html).toContain("org-a");
    expect(html).toContain("org-b");
    expect(html).toContain(
      "https://github.com/apps/acme-lookup/installations/new",
    );
    expect(html).toContain(
      'action="/admin/settings/github-enterprise/orgs/org-a/install"',
    );
    expect(html).toContain('value="agent-1"');
    expect(html).toContain("Install agent app");
    expect(html).toContain("Installed");
  });

  test("org list failure and top-level error/notice are escaped messages", () => {
    const html = renderGithubEnterpriseSettingsPage({
      ...base,
      status: { configured: true, installer: app(), lookup: null },
      orgsError: "GitHub could not be reached <x>",
      error: "bad <script>",
      notice: "Saved.",
    });
    expect(html).toContain("GitHub could not be reached &lt;x&gt;");
    expect(html).toContain("bad &lt;script&gt;");
    expect(html).toContain("Saved.");
    expect(html).not.toContain("<script>alert");
  });
});

describe("toolbar Settings entry", () => {
  test("hidden outside a settings-nav context, shown inside one", () => {
    expect(renderAdminToolbar("a@x.com")).not.toContain("/admin/settings");
    const html = runWithSettingsNav(true, () => renderAdminToolbar("a@x.com"));
    expect(html).toContain('href="/admin/settings/github-enterprise"');
  });
});
