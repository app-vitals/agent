/**
 * admin/src/admin-ui-account-nav.ts
 * Per-request toolbar audience. renderAdminToolbar() is called from dozens of
 * page renderers; rather than thread a parameter through all of them, an
 * admin-ui middleware wraps each /admin/* request in runWithToolbarAudience()
 * and the toolbar reads it back. Outside any context (tests, other services)
 * no audience is set and the toolbar renders its legacy default (no Settings).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolbarAudience } from "@app-vitals/agent-lib/web/toolbar.ts";

export interface ToolbarViewer {
  audience: ToolbarAudience;
}

const storage = new AsyncLocalStorage<ToolbarViewer>();

/** Wrap a request so the toolbar renders for the given audience. */
export function runWithToolbarAudience<T>(
  audience: ToolbarAudience,
  fn: () => T,
): T {
  return storage.run({ audience }, fn);
}

export function currentToolbarViewer(): ToolbarViewer | undefined {
  return storage.getStore();
}
