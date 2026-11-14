import { describe, expect, it } from "bun:test";
import {
  mergeSettingsNavItems,
  renderSettingsLayout,
  type SettingsNav,
} from "./admin-ui-settings-layout.ts";

const base = (): SettingsNav => ({
  sections: [
    { label: "General", items: [{ label: "Profile", path: "/p" }] },
    { label: "Org", items: [{ label: "Members", path: "/m" }] },
  ],
});

describe("mergeSettingsNavItems", () => {
  it("appends into the section with a matching label", () => {
    const out = mergeSettingsNavItems(base(), [
      { section: "General", label: "Extra", path: "/x" },
    ]);
    expect(out.sections.map((s) => s.label)).toEqual(["General", "Org"]);
    expect(out.sections[0]?.items).toEqual([
      { label: "Profile", path: "/p" },
      { label: "Extra", path: "/x" },
    ]);
  });

  it("appends a new section at the end for an unknown label", () => {
    const out = mergeSettingsNavItems(base(), [
      { section: "Coding", label: "A", path: "/a" },
      { section: "Coding", label: "B", path: "/b" },
    ]);
    expect(out.sections.map((s) => s.label)).toEqual([
      "General",
      "Org",
      "Coding",
    ]);
    expect(out.sections[2]?.items.map((i) => i.label)).toEqual(["A", "B"]);
  });

  it("does not mutate the input", () => {
    const nav = base();
    const snapshot = structuredClone(nav);
    mergeSettingsNavItems(nav, [
      { section: "General", label: "Extra", path: "/x" },
      { section: "New", label: "N", path: "/n" },
    ]);
    expect(nav).toEqual(snapshot);
  });

  it("preserves adminOnly so non-admins do not see the item", () => {
    const nav = mergeSettingsNavItems(base(), [
      { section: "Coding", label: "Secret", path: "/s", adminOnly: true },
    ]);
    const render = (isAdmin: boolean) =>
      renderSettingsLayout({
        userName: "u",
        title: "T",
        nav,
        active: "/p",
        body: "",
        isAdmin,
      });
    expect(render(false)).not.toContain("Secret");
    expect(render(true)).toContain("Secret");
  });
});
