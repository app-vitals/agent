/**
 * admin/src/reconcile-open-work.ts
 * Optional open-work port. The admin package knows nothing about task stores;
 * a consumer that does (shipwright) may supply this port so work on repos
 * removed from an agent gets blocked.
 * Additive and optional: with no port, nothing is listed or blocked.
 */

export interface OpenWorkItem {
  /** Consumer-defined id (e.g. a task id). */
  id: string;
  /** owner/repo the item belongs to. */
  repo: string;
  title?: string;
}

export interface OpenWorkPort {
  /** Open work the agent holds on any of `repos` (owner/repo). */
  listOpenWork(
    agentId: string,
    repos: readonly string[],
  ): Promise<OpenWorkItem[]>;
  /** Block the agent's open work on `repos`; `reason` is shown to humans. */
  blockOpenWork(
    agentId: string,
    repos: readonly string[],
    reason: string,
  ): Promise<void>;
}
