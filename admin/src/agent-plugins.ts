/**
 * agent/src/agent-plugins.ts
 * AgentPluginService — CRUD for Claude Code plugins per agent.
 *
 * Each plugin is identified by its canonical Claude install spec — the string
 * passed to `claude plugin install`: "<plugin>@<marketplace>" (e.g.
 * "shipwright@shipwright"), or a bare "<plugin>" that defaults to the bundled
 * "shipwright" marketplace.
 * The unique constraint on [agentId, name] prevents duplicates; add() uses
 * upsert so re-adding an existing plugin updates its version and re-enables it.
 */

import type { AgentPlugin, PrismaClient } from "../prisma/client/client.ts";
import { NotFoundError } from "./errors.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

export type { AgentPlugin };

export class AgentPluginService {
  constructor(private prisma: PrismaClient) {}

  /**
   * List all plugins for a given agent, ordered by createdAt.
   */
  async list(agentId: string): Promise<AgentPlugin[]> {
    return this.prisma.agentPlugin.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * List enabled plugins for a given agent, ordered by createdAt.
   * Filters `enabled: true` server-side.
   */
  async listEnabled(agentId: string): Promise<AgentPlugin[]> {
    return this.prisma.agentPlugin.findMany({
      where: { agentId, enabled: true },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Add a plugin for the given agent.
   * Uses upsert so re-adding an existing plugin updates its version and re-enables it.
   *
   * @param client - defaults to `this.prisma`; pass the `tx` argument from a
   *   caller's `prisma.$transaction(async (tx) => ...)` to make this write
   *   participate in that transaction (see createAgent() in agents.ts).
   */
  async add(
    agentId: string,
    name: string,
    version?: string | null,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentPlugin> {
    return client.agentPlugin.upsert({
      where: { agentId_name: { agentId, name } },
      create: {
        agentId,
        name,
        version: version ?? null,
        enabled: true,
        source: "custom",
      },
      update: { version: version ?? null, enabled: true, source: "custom" },
    });
  }

  /**
   * Internal reconcile write path (ATP-1.2); never exposed over HTTP.
   * Creates a template-sourced plugin, or refreshes one that is still
   * template-owned. A custom row (user edit or tombstone) is returned
   * untouched so a reconcile neither overrides nor resurrects it.
   */
  async addFromTemplate(
    agentId: string,
    name: string,
    version?: string | null,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentPlugin> {
    const existing = await client.agentPlugin.findUnique({
      where: { agentId_name: { agentId, name } },
    });
    if (existing?.source === "custom") return existing;
    return client.agentPlugin.upsert({
      where: { agentId_name: { agentId, name } },
      create: {
        agentId,
        name,
        version: version ?? null,
        enabled: true,
        source: "template",
      },
      update: { version: version ?? null, enabled: true, source: "template" },
    });
  }

  /** Delete the row, or tombstone it when it is template-sourced (ATP-1.2). */
  private async removeRow(row: AgentPlugin): Promise<void> {
    if (row.source === "template") {
      await this.prisma.agentPlugin.update({
        where: { id: row.id },
        data: { enabled: false, source: "custom" },
      });
      return;
    }
    await this.prisma.agentPlugin.delete({ where: { id: row.id } });
  }

  /**
   * Remove a plugin by ID. Verifies agentId ownership before deleting.
   * Throws NotFoundError if the pluginId doesn't exist or belongs to a different agent.
   */
  async remove(agentId: string, pluginId: string): Promise<void> {
    const existing = await this.prisma.agentPlugin.findUnique({
      where: { id: pluginId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`plugin ${pluginId} not found`);
    }

    await this.removeRow(existing);
  }

  /**
   * Remove a plugin by name. Verifies agentId ownership before deleting.
   * Throws NotFoundError if no plugin with that name exists for the agent.
   */
  async removeByName(agentId: string, name: string): Promise<void> {
    const existing = await this.prisma.agentPlugin.findUnique({
      where: { agentId_name: { agentId, name } },
    });

    if (!existing) {
      throw new NotFoundError(`plugin ${name} not found`);
    }

    await this.removeRow(existing);
  }
}
