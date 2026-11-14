/**
 * admin/src/admin-ui-templates-pages.unit.test.ts
 * Unit tests for renderTemplatesPage (ATP-2.3).
 */

import { describe, expect, it } from "bun:test";
import {
  renderTemplatesPage,
  type TemplatesPageOpts,
} from "./admin-ui-templates-pages.ts";

const base: TemplatesPageOpts = {
  userEmail: "a@x.com",
  accountOptions: [{ value: "", label: "Deployment-wide" }],
  specialtyOptions: [{ value: "", label: "All agent types" }],
  accountId: "",
  specialty: "",
  items: [],
  templateExists: false,
};

describe("renderTemplatesPage", () => {
  it("renders a card per kind and an add form each", () => {
    const html = renderTemplatesPage(base);
    for (const k of ["env", "tool", "plugin", "cron"]) {
      expect(html).toContain(`id="template-${k}"`);
    }
    expect(html).toContain("No template exists for this scope yet");
    expect(html).not.toContain("Delete this template");
  });

  it("escapes values and shows the selected scope", () => {
    const html = renderTemplatesPage({
      ...base,
      accountOptions: [{ value: "a1", label: "<b>Acme</b>" }],
      accountId: "a1",
      templateExists: true,
      error: "<script>x</script>",
      items: [
        {
          kind: "env",
          key: "K",
          payload: { value: "***", secret: true },
        },
      ],
    });
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(html).toContain('<option value="a1" selected>');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain('value="***"');
    expect(html).toContain("Delete this template");
    expect(html).toMatch(/name="secret" value="1" checked/);
  });
});

describe("renderTemplatesPage settings shell (SGL-2.2)", () => {
  it("renders inside the settings layout with Templates active", () => {
    const html = renderTemplatesPage({ ...base, isAdmin: true });
    expect(html).toContain("settings-sidebar");
    expect(html).toContain(
      'href="/admin/settings/templates" aria-current="page">Templates',
    );
    expect(html).toContain("Agent templates");
  });

  it("hides the adminOnly GitHub Enterprise item from non-admins", () => {
    const member = renderTemplatesPage(base);
    expect(member).not.toContain(
      'class="settings-nav-link" href="/admin/settings/github-enterprise"',
    );
    const admin = renderTemplatesPage({ ...base, isAdmin: true });
    expect(admin).toContain(
      'class="settings-nav-link" href="/admin/settings/github-enterprise"',
    );
  });
});
