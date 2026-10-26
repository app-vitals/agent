/**
 * admin/src/agent-github-installations.ts
 * AgentGitHubInstallationsService — push/read for an agent's latest reported
 * GitHub App installations.
 *
 * One row per agent (AgentGitHubInstallationsSnapshot.agentId is @unique).
 * push() upserts the single row, replacing the installations list wholesale —
 * an installation absent from the latest push is gone. repoAccess (COS-44.1)
 * is only written when the push carries it, so a push from a runtime with the
 * check off never wipes a result stored earlier.
 */

import type {
  AgentGitHubInstallationsSnapshot,
  Prisma,
  PrismaClient,
} from "../prisma/client/client.ts";

export type { AgentGitHubInstallationsSnapshot };

interface PushGitHubInstallationsInput {
  reportedAt: Date;
  installations: Prisma.InputJsonValue;
  /** Omitted leaves the stored per-repo access result unchanged; [] clears it. */
  repoAccess?: Prisma.InputJsonValue;
}

export class AgentGitHubInstallationsService {
  constructor(private prisma: PrismaClient) {}

  /** Upsert the single snapshot row for the agent (replace-all). */
  async push(
    agentId: string,
    input: PushGitHubInstallationsInput,
  ): Promise<AgentGitHubInstallationsSnapshot> {
    return this.prisma.agentGitHubInstallationsSnapshot.upsert({
      where: { agentId },
      create: {
        agentId,
        reportedAt: input.reportedAt,
        installations: input.installations,
        ...(input.repoAccess === undefined
          ? {}
          : { repoAccess: input.repoAccess }),
      },
      update: {
        reportedAt: input.reportedAt,
        installations: input.installations,
        ...(input.repoAccess === undefined
          ? {}
          : { repoAccess: input.repoAccess }),
      },
    });
  }

  /** Latest snapshot for the agent, or null if never reported. */
  async get(agentId: string): Promise<AgentGitHubInstallationsSnapshot | null> {
    return this.prisma.agentGitHubInstallationsSnapshot.findUnique({
      where: { agentId },
    });
  }
}
