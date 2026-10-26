/**
 * admin/src/agent-account-assignment.ts
 * Post-assignment side effect for SSP-5.3 (admin assign/reassign an agent to
 * an account). The task-store scope resolver reads Agent.accountId live, so no
 * token re-mint is needed — only the tenant pod label / CPU limit (SSP-7.1)
 * has to be re-applied, by reconciling the single agent's workload.
 */

import type { AgentAnthropicIdentity } from "./agent-anthropic-identity.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";

/**
 * Reconciles the agent's K8s workload after its accountId changed. Self-hosted
 * agents have no workload, so they are skipped. Never throws: the DB change is
 * already committed, so a reconcile failure is returned as a warning string
 * (the next full reconcile pass will converge it) instead of failing the call.
 */
type ReconcilableAgent = Partial<AgentAnthropicIdentity> & {
  id: string;
  name: string;
  selfHosted: boolean;
  accountId?: string | null;
  podServiceAccountName?: string | null;
};

export function reconcileAgentAfterAccountChange(
  provisioner: Pick<AgentProvisioner, "reconcile">,
  agent: ReconcilableAgent,
): Promise<string | undefined> {
  return reconcileAgentWorkload(provisioner, agent, "account updated");
}

/**
 * COS-49.1: reconciles the workload after podServiceAccountName changed.
 * `previous` is the column value before the update; the provisioner uses it to
 * clear the live ServiceAccount only when it is still the one it applied.
 */
export function reconcileAgentAfterPodServiceAccountChange(
  provisioner: Pick<AgentProvisioner, "reconcile">,
  agent: ReconcilableAgent,
  previous: string | null,
): Promise<string | undefined> {
  return reconcileAgentWorkload(
    provisioner,
    agent,
    "pod service account updated",
    previous,
  );
}

async function reconcileAgentWorkload(
  provisioner: Pick<AgentProvisioner, "reconcile">,
  agent: ReconcilableAgent,
  what: string,
  previousPodServiceAccountName?: string | null,
): Promise<string | undefined> {
  if (agent.selfHosted) return undefined;
  try {
    const result = await provisioner.reconcile([
      {
        id: agent.id,
        slug: agent.name,
        accountId: agent.accountId ?? null,
        ownerEmail: agent.ownerEmail,
        anthropicIdentityName: agent.anthropicIdentityName,
        anthropicServiceAccountId: agent.anthropicServiceAccountId,
        anthropicFederationRuleId: agent.anthropicFederationRuleId,
        k8sServiceAccountName: agent.k8sServiceAccountName,
        podServiceAccountName: agent.podServiceAccountName,
        ...(previousPodServiceAccountName !== undefined
          ? { previousPodServiceAccountName }
          : {}),
      },
    ]);
    const failure = result.failed.find((f) => f.agentId === agent.id);
    return failure
      ? `${what}, but reconciling the agent workload failed: ${failure.error}`
      : undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `${what}, but reconciling the agent workload failed: ${message}`;
  }
}
