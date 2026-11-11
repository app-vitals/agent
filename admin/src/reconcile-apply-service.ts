/**
 * admin/src/reconcile-apply-service.ts
 * ReconcileApplyService (GHE-3.3): the applying half of the GitHub repo
 * reconcile. Re-plans server-side with planReconcile and applies only when the
 * fresh plan still matches the hash the admin reviewed.
 *
 * Order of checks: skipped plan (nothing changes, no audit) -> empty plan
 * (idempotent no-op) -> stale hash -> removal cap -> apply. Apply runs
 * installation changes first (adds, then removes), then the agent config, then
 * writes the audit entry. Open work on removed repos is blocked last, through
 * the optional OpenWorkPort; a port failure is a warning, never a failed apply.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import {
  type OpenWorkItem,
  type OpenWorkPort,
  removedRepoBlockReason,
} from "./reconcile-open-work.ts";
import {
  planReconcile,
  type ReconcileDiff,
  type ReconcilePlan,
  repoOrg,
} from "./reconcile-planner.ts";

/** Parses a stored GH_APP_ID; unset or non-numeric -> undefined. */
function parseAppId(raw: string | undefined): number | undefined {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** More removals than this need confirmRemovals. */
export const MAX_UNCONFIRMED_REMOVALS = 10;

export interface ReconcileAgentRecord {
  id: string;
  repos: string[];
  githubUsername: string | null;
  /** The agent's own GitHub App id (its stored GH_APP_ID); undefined when unset or not numeric. */
  appId?: number;
}

export interface ReconcileAgentsPort {
  get(agentId: string): Promise<ReconcileAgentRecord | null>;
  setRepos(agentId: string, repos: string[]): Promise<void>;
}

/**
 * Repo access on an agent App's installations, per org login. Each agent has
 * its own App, so every call names the App (`appId`) whose installation is used.
 */
export interface ReconcileInstallationPort {
  /** Repos the agent App covers in each org; only the named orgs are needed. */
  listRepos(
    appId: number,
    orgs: readonly string[],
  ): Promise<Record<string, string[]>>;
  /** Grant the installation access to repos (owner/repo, all in `org`). */
  addRepos(appId: number, org: string, repos: readonly string[]): Promise<void>;
  removeRepos(
    appId: number,
    org: string,
    repos: readonly string[],
  ): Promise<void>;
}

export interface ReconcileAuditEntry {
  agentId: string;
  caller: string;
  planHash: string;
  diff: ReconcileDiff;
  result: ReconcileAuditResult;
}

export interface ReconcileAuditResult {
  status: "applied" | "failed";
  error?: string;
}

export interface ReconcileAuditPort {
  write(entry: ReconcileAuditEntry): Promise<string>;
}

export interface ReconcileApplyDeps {
  agents: ReconcileAgentsPort;
  /** Resolves the bound user's access; "unconfigured" skips the plan. */
  access: GithubAccessPreviewFn;
  installation: ReconcileInstallationPort;
  audit: ReconcileAuditPort;
  /** Optional: with none, nothing is listed or blocked. */
  openWork?: OpenWorkPort;
}

export interface ReconcileApplyInput {
  agentId: string;
  /** Who asked for the apply (audit trail). */
  caller: string;
  /** Hash of the plan the admin reviewed. */
  planHash: string;
  namedAdds?: readonly string[];
  confirmRemovals?: boolean;
}

export type ReconcileApplyResult =
  | { status: "agent_not_found" }
  | { status: "skipped"; plan: ReconcilePlan }
  | { status: "noop"; plan: ReconcilePlan }
  | { status: "stale_plan"; plan: ReconcilePlan }
  | { status: "removal_cap"; plan: ReconcilePlan; removals: number }
  | {
      status: "applied";
      plan: ReconcilePlan;
      auditId: string;
      warnings: string[];
    }
  | {
      status: "failed";
      plan: ReconcilePlan;
      auditId: string;
      error: string;
    };

/** Skip reason when the agent has no usable GH_APP_ID in its stored env. */
export const MISSING_APP_ID_REASON =
  "agent has no GH_APP_ID in its stored env (its own GitHub App is not set up)";

const orgsOf = (repos: readonly string[]): string[] =>
  [...new Set(repos.map(repoOrg))].sort();

function groupByOrg(repos: readonly string[]): Map<string, string[]> {
  const byOrg = new Map<string, string[]>();
  for (const r of repos) {
    const org = repoOrg(r);
    byOrg.set(org, [...(byOrg.get(org) ?? []), r]);
  }
  return byOrg;
}

export class ReconcileApplyService {
  constructor(private readonly deps: ReconcileApplyDeps) {}

  /** Plan only: no writes. Throws when the agent does not exist. */
  async plan(
    agentId: string,
    namedAdds?: readonly string[],
  ): Promise<ReconcilePlan> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    return this.planFor(agent, namedAdds);
  }

  /**
   * Plan plus the open work the removals would affect (GHE-3.4). Read-only.
   * Without a port the list is empty; a port failure adds a plan warning
   * rather than failing the preview.
   */
  async planWithOpenWork(
    agentId: string,
    namedAdds?: readonly string[],
  ): Promise<{ plan: ReconcilePlan; openWork: OpenWorkItem[] }> {
    const plan = await this.plan(agentId, namedAdds);
    const port = this.deps.openWork;
    const removed = plan.diff.configRemoves;
    if (!port || plan.skipped || removed.length === 0) {
      return { plan, openWork: [] };
    }
    try {
      return { plan, openWork: await port.listOpenWork(agentId, removed) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        plan: {
          ...plan,
          warnings: [...plan.warnings, `open work could not be listed: ${msg}`],
        },
        openWork: [],
      };
    }
  }

  private async planFor(
    agent: ReconcileAgentRecord,
    namedAdds?: readonly string[],
  ): Promise<ReconcilePlan> {
    const username = agent.githubUsername?.trim();
    const preview = username ? await this.deps.access(username) : null;
    // Unbound user or unconfigured Apps: a skipped plan, no installation calls.
    if (!preview || preview.status === "unconfigured") {
      const plan = planReconcile({
        username,
        access: null,
        agentRepos: agent.repos,
        installationRepos: {},
      });
      return preview
        ? { ...plan, skipReason: "GitHub Apps are not configured" }
        : plan;
    }
    if (agent.appId === undefined) {
      const plan = planReconcile({
        username,
        access: null,
        agentRepos: agent.repos,
        installationRepos: {},
      });
      return { ...plan, skipReason: MISSING_APP_ID_REASON };
    }
    const installationRepos = await this.deps.installation.listRepos(
      agent.appId,
      orgsOf([...agent.repos, ...(namedAdds ?? [])]),
    );
    return planReconcile({
      username,
      access: preview.access,
      agentRepos: agent.repos,
      installationRepos,
      namedAdds,
    });
  }

  async apply(input: ReconcileApplyInput): Promise<ReconcileApplyResult> {
    const agent = await this.deps.agents.get(input.agentId);
    if (!agent) return { status: "agent_not_found" };

    const plan = await this.planFor(agent, input.namedAdds);
    if (plan.skipped) return { status: "skipped", plan };
    if (plan.empty) return { status: "noop", plan };
    if (plan.planHash !== input.planHash) return { status: "stale_plan", plan };

    const removals = plan.diff.configRemoves.length;
    if (removals > MAX_UNCONFIRMED_REMOVALS && !input.confirmRemovals) {
      return { status: "removal_cap", plan, removals };
    }

    const entry = {
      agentId: input.agentId,
      caller: input.caller,
      planHash: plan.planHash,
      diff: plan.diff,
    };
    try {
      await this.applyInstallation(agent, plan.diff);
      await this.applyConfig(agent, plan.diff);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const auditId = await this.deps.audit.write({
        ...entry,
        result: { status: "failed", error },
      });
      return { status: "failed", plan, auditId, error };
    }
    const auditId = await this.deps.audit.write({
      ...entry,
      result: { status: "applied" },
    });
    const warnings = await this.blockRemoved(
      input.agentId,
      plan.diff.configRemoves,
    );
    return { status: "applied", plan, auditId, warnings };
  }

  private async applyInstallation(
    agent: ReconcileAgentRecord,
    diff: ReconcileDiff,
  ): Promise<void> {
    const { installation } = this.deps;
    const hasChanges =
      diff.installationAdds.length + diff.installationRemoves.length > 0;
    if (agent.appId === undefined) {
      if (hasChanges) throw new Error(MISSING_APP_ID_REASON);
      return;
    }
    for (const [org, repos] of groupByOrg(diff.installationAdds)) {
      await installation.addRepos(agent.appId, org, repos);
    }
    for (const [org, repos] of groupByOrg(diff.installationRemoves)) {
      await installation.removeRepos(agent.appId, org, repos);
    }
  }

  private async applyConfig(
    agent: ReconcileAgentRecord,
    diff: ReconcileDiff,
  ): Promise<void> {
    const removed = new Set(diff.configRemoves);
    const next = agent.repos.filter((r) => !removed.has(r));
    for (const r of diff.configAdds) if (!next.includes(r)) next.push(r);
    await this.deps.agents.setRepos(agent.id, next);
  }

  private async blockRemoved(
    agentId: string,
    removed: readonly string[],
  ): Promise<string[]> {
    const port = this.deps.openWork;
    if (!port || removed.length === 0) return [];
    const warnings: string[] = [];
    for (const repo of removed) {
      try {
        await port.listOpenWork(agentId, [repo]);
        await port.blockOpenWork(agentId, [repo], removedRepoBlockReason(repo));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`open work for ${repo} was not blocked: ${msg}`);
      }
    }
    return warnings;
  }
}

/** Prisma-backed audit store (GitHubReconcileAudit). */
export class PrismaReconcileAudit implements ReconcileAuditPort {
  constructor(private readonly prisma: PrismaClient) {}

  async write(entry: ReconcileAuditEntry): Promise<string> {
    const row = await this.prisma.gitHubReconcileAudit.create({
      data: {
        agentId: entry.agentId,
        caller: entry.caller,
        planHash: entry.planHash,
        diff: entry.diff as unknown as object,
        result: entry.result as unknown as object,
      },
    });
    return row.id;
  }
}

/** Prisma-backed agent reads/writes for the reconcile. */
export class PrismaReconcileAgents implements ReconcileAgentsPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Pick<AgentEnvService, "getConfigBundle">,
  ) {}

  async get(agentId: string): Promise<ReconcileAgentRecord | null> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, repos: true, githubUsername: true },
    });
    if (!agent) return null;
    const raw = (await this.env.getConfigBundle(agentId))?.env.GH_APP_ID;
    const appId = parseAppId(raw);
    return appId === undefined ? agent : { ...agent, appId };
  }

  async setRepos(agentId: string, repos: string[]): Promise<void> {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { repos },
    });
  }
}

/** The slice of GithubEnterpriseClient the installation port needs. */
export interface InstallationRepoClient {
  listOrgInstallations(org: string): Promise<{ id: number; appId: number }[]>;
  listInstallationRepositories(
    org: string,
    installationId: number,
  ): Promise<{ fullName: string }[]>;
  addRepositories(
    org: string,
    installationId: number,
    names: readonly string[],
  ): Promise<unknown>;
  removeRepositories(
    org: string,
    installationId: number,
    names: readonly string[],
  ): Promise<unknown>;
}

/** The agent App has no installation on the org (distinct from a GitHub failure). */
export class AppNotInstalledError extends Error {
  constructor(
    readonly appId: number,
    readonly org: string,
  ) {
    super(
      `agent App ${appId} (the agent's GH_APP_ID) is not installed on org ${org}`,
    );
    this.name = "AppNotInstalledError";
  }
}

const baseName = (fullName: string): string => fullName.split("/")[1] ?? "";

/**
 * ReconcileInstallationPort over GithubEnterpriseClient (GHE-3.1). Each call
 * is scoped to the named agent App's installation on the org.
 */
export function createInstallationPort(
  client: InstallationRepoClient,
): ReconcileInstallationPort {
  const installationId = async (
    appId: number,
    org: string,
  ): Promise<number> => {
    const found = (await client.listOrgInstallations(org)).find(
      (i) => i.appId === appId,
    );
    if (!found) {
      throw new AppNotInstalledError(appId, org);
    }
    return found.id;
  };
  return {
    async listRepos(appId, orgs) {
      const out: Record<string, string[]> = {};
      for (const org of orgs) {
        const repos = await client.listInstallationRepositories(
          org,
          await installationId(appId, org),
        );
        out[org] = repos.map((r) => r.fullName);
      }
      return out;
    },
    async addRepos(appId, org, repos) {
      await client.addRepositories(
        org,
        await installationId(appId, org),
        repos.map(baseName),
      );
    },
    async removeRepos(appId, org, repos) {
      await client.removeRepositories(
        org,
        await installationId(appId, org),
        repos.map(baseName),
      );
    },
  };
}
