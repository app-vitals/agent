import { describe, expect, it } from "bun:test";
import * as server from "./server.ts";

describe("server.ts export surface", () => {
  it("exports the settings layout helpers", () => {
    expect(typeof server.renderSettingsLayout).toBe("function");
    expect(typeof server.mergeSettingsNavItems).toBe("function");
  });

  it("keeps existing exports", () => {
    expect(typeof server.createAdminUIApp).toBe("function");
    expect(typeof server.createAdminApp).toBe("function");
  });

  it("type exports compile", () => {
    const item: server.SettingsNavItem = { label: "l", path: "/l" };
    const section: server.SettingsNavSection = { label: "s", items: [item] };
    const nav: server.SettingsNav = { sections: [section] };
    const c: server.SettingsNavContribution = {
      section: "s",
      label: "l",
      path: "/l",
    };
    const ext: server.AdminExtension = { settingsNavItems: () => [c] };
    const opts: server.RenderSettingsLayoutOptions = {
      userName: "u",
      title: "t",
      nav,
      active: "/l",
      body: "",
    };
    expect(server.renderSettingsLayout(opts)).toContain("l");
    expect(ext.settingsNavItems).toBeDefined();
  });
});
