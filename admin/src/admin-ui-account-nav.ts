/**
 * admin/src/admin-ui-account-nav.ts
 * Per-request "show the Settings nav entry" flag. renderAdminToolbar()
 * is called from dozens of page renderers; rather than thread a parameter
 * through all of them, an admin-ui middleware wraps each /admin/* request in
 * runWithAccountNav() and the toolbar reads the flag back. Outside any
 * context (tests, other services) the entry is hidden.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface NavFlags {
  /** The "Settings" entry (admins and account members). */
  showSettings: boolean;
}

const storage = new AsyncLocalStorage<NavFlags>();

/** Wrap a request so the toolbar shows (or hides) the admin Settings entry. */
export function runWithSettingsNav<T>(showSettings: boolean, fn: () => T): T {
  return storage.run({ showSettings }, fn);
}

export function shouldShowSettingsNav(): boolean {
  return storage.getStore()?.showSettings === true;
}
