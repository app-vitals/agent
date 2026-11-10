/**
 * admin/src/admin-ui-account-nav.ts
 * Per-request "show the Account nav entry" flag (SSP-3.2). renderAdminToolbar()
 * is called from dozens of page renderers; rather than thread a parameter
 * through all of them, an admin-ui middleware wraps each /admin/* request in
 * runWithAccountNav() and the toolbar reads the flag back. Outside any
 * context (tests, other services) the entry is hidden.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface NavFlags {
  showAccount: boolean;
  /** GHE-1.4: the admin-only "Settings" entry. */
  showSettings: boolean;
}

const storage = new AsyncLocalStorage<NavFlags>();

export function runWithAccountNav<T>(showAccount: boolean, fn: () => T): T {
  const showSettings = storage.getStore()?.showSettings === true;
  return storage.run({ showAccount, showSettings }, fn);
}

export function shouldShowAccountNav(): boolean {
  return storage.getStore()?.showAccount === true;
}

/** Wrap a request so the toolbar shows (or hides) the admin Settings entry. */
export function runWithSettingsNav<T>(showSettings: boolean, fn: () => T): T {
  const showAccount = storage.getStore()?.showAccount === true;
  return storage.run({ showAccount, showSettings }, fn);
}

export function shouldShowSettingsNav(): boolean {
  return storage.getStore()?.showSettings === true;
}
