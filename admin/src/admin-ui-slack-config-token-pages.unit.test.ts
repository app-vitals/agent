/**
 * admin/src/admin-ui-slack-config-token-pages.unit.test.ts
 * Unit tests for renderSlackConfigTokenPage (SCT-3.1).
 */

import { describe, expect, it } from "bun:test";
import {
  renderSlackConfigTokenPage,
  type SlackConfigTokenPageOpts,
} from "./admin-ui-slack-config-token-pages.ts";

const base: SlackConfigTokenPageOpts = {
  userEmail: "a@x.com",
  isAdmin: true,
  accountOptions: [{ value: "", label: "Deployment-wide" }],
  accountId: "",
  status: null,
  encryptionConfigured: true,
};

describe("renderSlackConfigTokenPage", () => {
  it("shows the unconfigured state without rotate/clear actions", () => {
    const html = renderSlackConfigTokenPage(base);
    expect(html).toContain("Not configured for this scope");
    expect(html).toContain("Add refresh token");
    expect(html).not.toContain("Rotate now");
    expect(html).not.toContain("Clear token");
  });

  it("shows status metadata and actions when configured", () => {
    const html = renderSlackConfigTokenPage({
      ...base,
      status: {
        lastRotatedAt: new Date("2026-11-16T00:00:00Z"),
        lastError: "invalid_refresh_token",
        slackTeamId: "T123",
        slackUserId: "U456",
      },
    });
    expect(html).toContain("2026-11-16T00:00:00.000Z");
    expect(html).toContain("invalid_refresh_token");
    expect(html).toContain("T123 / U456");
    expect(html).toContain("Rotate now");
    expect(html).toContain("Clear token");
    expect(html).toContain("Replace refresh token");
  });

  it("warns and disables save when the encryption key is missing", () => {
    const html = renderSlackConfigTokenPage({
      ...base,
      encryptionConfigured: false,
    });
    expect(html).toContain("SHIPWRIGHT_ENCRYPTION_KEY is not configured");
    expect(html).toContain(" disabled");
  });

  it("escapes error, notice and scope labels and marks the selected scope", () => {
    const html = renderSlackConfigTokenPage({
      ...base,
      accountOptions: [{ value: "a1", label: "<b>Acme</b>" }],
      accountId: "a1",
      error: "<script>x</script>",
      notice: "<i>n</i>",
    });
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(html).toContain('<option value="a1" selected>');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&lt;i&gt;n&lt;/i&gt;");
  });

  it("never pre-fills the token input", () => {
    const html = renderSlackConfigTokenPage({
      ...base,
      status: {
        lastRotatedAt: null,
        lastError: null,
        slackTeamId: null,
        slackUserId: null,
      },
    });
    expect(html).toMatch(/name="refreshToken"[^>]*type|type="password"/);
    expect(html).not.toMatch(/name="refreshToken"[^>]*value=/);
  });
});
