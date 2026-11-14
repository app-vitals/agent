/**
 * agent/src/agent-tools.ts
 * AgentToolService — CRUD for allowed tool patterns per agent.
 *
 * Each pattern grants an agent permission to use a specific tool (e.g. "Read",
 * "Bash", "Write"). The unique constraint on [agentId, pattern] prevents
 * duplicates; add() uses upsert so it re-enables a previously disabled pattern.
 */

import type { AgentTool, PrismaClient } from "../prisma/client/client.ts";
import { NotFoundError } from "./errors.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

export type { AgentTool };

export class AgentToolService {
  constructor(private prisma: PrismaClient) {}

  /**
   * List all tool patterns for a given agent, ordered by createdAt.
   */
  async list(agentId: string): Promise<AgentTool[]> {
    return this.prisma.agentTool.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Add a tool pattern for the given agent.
   * Uses upsert so re-adding a disabled pattern re-enables it.
   *
   * @param client - defaults to `this.prisma`; pass the `tx` argument from a
   *   caller's `prisma.$transaction(async (tx) => ...)` to make this write
   *   participate in that transaction (see createAgent() in agents.ts).
   */
  async add(
    agentId: string,
    pattern: string,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentTool> {
    return client.agentTool.upsert({
      where: { agentId_pattern: { agentId, pattern } },
      create: { agentId, pattern, enabled: true, source: "custom" },
      update: { enabled: true, source: "custom" },
    });
  }

  /**
   * Internal reconcile write path (ATP-1.2); never exposed over HTTP.
   * Creates a template-sourced pattern, or refreshes one that is still
   * template-owned. A custom row (user edit or tombstone) is returned
   * untouched so a reconcile neither overrides nor resurrects it.
   */
  async addFromTemplate(
    agentId: string,
    pattern: string,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentTool> {
    const existing = await client.agentTool.findUnique({
      where: { agentId_pattern: { agentId, pattern } },
    });
    if (existing?.source === "custom") return existing;
    return client.agentTool.upsert({
      where: { agentId_pattern: { agentId, pattern } },
      create: { agentId, pattern, enabled: true, source: "template" },
      update: { enabled: true, source: "template" },
    });
  }

  /**
   * Delete a tool pattern. Verifies agentId ownership before deleting.
   * Throws NotFoundError if the toolId doesn't exist or belongs to a different agent.
   */
  async remove(agentId: string, toolId: string): Promise<void> {
    const existing = await this.prisma.agentTool.findUnique({
      where: { id: toolId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`tool ${toolId} not found`);
    }

    // ATP-1.2: deleting a template row writes a tombstone so a later
    // reconcile does not re-add it.
    if (existing.source === "template") {
      await this.prisma.agentTool.update({
        where: { id: toolId },
        data: { enabled: false, source: "custom" },
      });
      return;
    }
    await this.prisma.agentTool.delete({ where: { id: toolId } });
  }

  /**
   * Enable or disable a tool pattern.
   * Throws NotFoundError if the toolId doesn't exist or belongs to a different agent.
   */
  async toggle(
    agentId: string,
    toolId: string,
    enabled: boolean,
  ): Promise<AgentTool> {
    const existing = await this.prisma.agentTool.findUnique({
      where: { id: toolId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`tool ${toolId} not found`);
    }

    return this.prisma.agentTool.update({
      where: { id: toolId },
      data: { enabled, source: "custom" },
    });
  }

  /**
   * Update the pattern string for a tool.
   * Verifies agentId ownership before updating.
   * Throws NotFoundError if the toolId doesn't exist or belongs to a different agent.
   */
  async updatePattern(
    agentId: string,
    toolId: string,
    pattern: string,
  ): Promise<AgentTool> {
    const existing = await this.prisma.agentTool.findUnique({
      where: { id: toolId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`tool ${toolId} not found`);
    }

    return this.prisma.agentTool.update({
      where: { id: toolId },
      data: { pattern, source: "custom" },
    });
  }
}
