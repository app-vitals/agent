/**
 * admin/src/admin-ui-styles.unit.test.ts
 *
 * Unit tests for the shared admin CSS string builder — no I/O, pure string
 * assertions. Real responsive *behavior* (computed styles at real viewports)
 * is covered by admin/e2e/*.e2e.ts; these tests only lock in the structural
 * invariants that the e2e suite can't cheaply assert per-change (breakpoint
 * constant interpolation, the .data-table .btn touch-target exception).
 */

import { describe, expect, test } from "bun:test";
import {
  BREAKPOINT_MOBILE_MAX,
  BREAKPOINT_TABLET_MAX,
  baseStyles,
} from "./admin-ui-styles.ts";

describe("baseStyles — CFB-3.1 responsive breakpoints", () => {
  test("BREAKPOINT_MOBILE_MAX and BREAKPOINT_TABLET_MAX are exported numeric constants", () => {
    expect(typeof BREAKPOINT_MOBILE_MAX).toBe("number");
    expect(typeof BREAKPOINT_TABLET_MAX).toBe("number");
    expect(BREAKPOINT_MOBILE_MAX).toBeLessThan(BREAKPOINT_TABLET_MAX);
  });

  test("mobile @media block is interpolated from BREAKPOINT_MOBILE_MAX, not a hardcoded literal", () => {
    const css = baseStyles();
    expect(css).toContain(`@media (max-width: ${BREAKPOINT_MOBILE_MAX}px)`);
  });

  test("a tablet band exists between BREAKPOINT_MOBILE_MAX and BREAKPOINT_TABLET_MAX", () => {
    const css = baseStyles();
    expect(css).toContain(
      `@media (min-width: ${BREAKPOINT_MOBILE_MAX + 1}px) and (max-width: ${BREAKPOINT_TABLET_MAX}px)`,
    );
  });

  test(".data-table .btn stays at its own explicit height, unaffected by the mobile-wide .btn min-height rule", () => {
    const css = baseStyles();
    // The un-scoped mobile-wide 44px override must exist...
    expect(css).toMatch(/\.btn\s*\{[^}]*min-height:\s*44px/);
    // ...and .data-table .btn must have an explicit, smaller override so it
    // isn't dragged up to 44px by cascade (both selectors are specificity
    // 0,2,0 vs 0,1,0 pairs; .data-table .btn must appear with its own value).
    expect(css).toMatch(/\.data-table \.btn\s*\{[^}]*min-height:\s*36px/);
  });

  test(".form-input has no unconditional 16px+ font-size outside the mobile @media block (base rule stays 14px, mobile-only override bumps it)", () => {
    const css = baseStyles();
    const formInputBase = css.match(/\.form-input\s*\{([^}]*)\}/);
    expect(formInputBase).not.toBeNull();
    expect(formInputBase?.[1]).toContain("font-size: 14px");
  });
});

describe("baseStyles — AXR-1.1 shared explore board component classes", () => {
  test("defines a scope-pill filter chip class", () => {
    const css = baseStyles();
    expect(css).toContain(".scope-pill");
  });

  test("defines the restyled pill/tag select class used by the Org/Repo multiselect fields", () => {
    const css = baseStyles();
    expect(css).toContain(".scope-select");
  });

  test("defines board/column layout classes for the kanban-style board pages", () => {
    const css = baseStyles();
    expect(css).toContain(".board");
    expect(css).toContain(".column");
  });

  test("defines new badge variants beyond the existing badge-hitl/badge-dep", () => {
    const css = baseStyles();
    expect(css).toContain(".badge-purple");
    expect(css).toContain(".badge-teal");
  });

  test("defines a header-tooltip pattern driven by a data-tip attribute", () => {
    const css = baseStyles();
    expect(css).toContain(".header-tooltip");
    expect(css).toContain("data-tip");
  });

  test("defines heartbeat-dot status indicator with fresh/aging/stale modifiers", () => {
    const css = baseStyles();
    expect(css).toContain(".heartbeat-dot");
    expect(css).toMatch(/\.heartbeat-dot\.fresh/);
    expect(css).toMatch(/\.heartbeat-dot\.aging/);
    expect(css).toMatch(/\.heartbeat-dot\.stale/);
  });

  test("defines more-filters disclosure styling", () => {
    const css = baseStyles();
    expect(css).toContain(".more-filters");
  });

  test("does not rename or remove existing badge/pill classes", () => {
    const css = baseStyles();
    expect(css).toContain(".badge-green");
    expect(css).toContain(".badge-gray");
    expect(css).toContain(".badge-warning");
  });
});

describe("baseStyles — SGL-1.1 settings layout", () => {
  const css = baseStyles();
  const start = css.indexOf("/* ─── Settings layout ─── */");
  const end = css.indexOf("/* ─── /Settings layout ─── */");
  const block = css.slice(start, end);

  test("marker-delimited block exists with the new classes", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const cls of [
      ".settings-sidebar",
      ".settings-nav-mobile",
      ".settings-content",
      ".settings-section-title",
      ".settings-danger-zone",
    ]) {
      expect(block).toContain(cls);
    }
  });

  test("full-width modifier and input cap", () => {
    expect(css).toMatch(
      /\.vos-page-wide\s*{\s*max-width:\s*none;\s*width:\s*100%;/,
    );
    expect(block).toMatch(/\.settings-content \.form-input[^}]*max-width: 640px/);
    expect(block).toContain('.settings-content input[type="search"]');
  });

  test("mobile media block references the settings classes", () => {
    const media = block.slice(
      block.indexOf(`@media (max-width: ${BREAKPOINT_MOBILE_MAX}px)`),
    );
    expect(media).toContain(".settings-sidebar");
    expect(media).toContain(".settings-nav-mobile");
  });

  test("uses only allowed hex colors", () => {
    const allowed = new Set(
      [
        "#1a1a2e",
        "#4f46e5",
        "#eef2ff",
        "#e8e8ee",
        "#f7f7fb",
        "#dc2626",
        "#fee2e2",
        "#6b7280",
        "#fff",
        "#f3f4f6",
        "#065f46",
        "#0f766e",
        "#22c55e",
        "#2d2d4e",
        "#374151",
        "#4338ca",
        "#5b21b6",
        "#92400e",
        "#9ca3af",
        "#a7f3d0",
        "#c7d2fe",
        "#ccfbf1",
        "#d1d5db",
        "#d1fae5",
        "#e5e7eb",
        "#ede9fe",
        "#ef4444",
        "#f59e0b",
        "#f9fafb",
        "#fafafa",
        "#fde68a",
        "#fecaca",
        "#fef3c7",
      ].map((c) => c.toLowerCase()),
    );
    const found = block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) expect(allowed.has(c.toLowerCase())).toBe(true);
  });
});
