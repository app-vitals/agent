/**
 * admin/src/repo-removal-open-work.ts
 * Shared preview + block logic for open work on a repo removed from an agent's
 * own repos (IRM-1.7; reused by IRM-1.3). Both helpers are no-ops without a
 * port, and a port failure is returned as a warning, never thrown, so the
 * removal itself always succeeds. Re-adding a repo never unblocks anything.
 */

import type { OpenWorkItem, OpenWorkPort } from "./reconcile-open-work.ts";

export function repoRemovedFromAgentBlockReason(repo: string): string {
  return `repo ${repo} was removed from the agent's repos`;
}

export interface RepoRemovalPreview {
  openWork: OpenWorkItem[];
  warnings: string[];
}

/** Read-only: the open work that removing `repos` would block. */
export async function previewRepoRemovalWork(
  port: OpenWorkPort | undefined,
  agentId: string,
  repos: readonly string[],
): Promise<RepoRemovalPreview> {
  if (!port || repos.length === 0) return { openWork: [], warnings: [] };
  try {
    return { openWork: await port.listOpenWork(agentId, repos), warnings: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      openWork: [],
      warnings: [`open work could not be listed: ${msg}`],
    };
  }
}

/** Blocks the agent's open work on each removed repo; returns warnings. */
export async function blockRepoRemovalWork(
  port: OpenWorkPort | undefined,
  agentId: string,
  repos: readonly string[],
): Promise<string[]> {
  if (!port) return [];
  const warnings: string[] = [];
  for (const repo of repos) {
    try {
      await port.blockOpenWork(
        agentId,
        [repo],
        repoRemovedFromAgentBlockReason(repo),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`open work for ${repo} was not blocked: ${msg}`);
    }
  }
  return warnings;
}
