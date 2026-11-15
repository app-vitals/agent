/**
 * agent/src/agent-envs.ts
 * AgentEnvService — generic env var store for deployed agents.
 *
 * Keys are env var names (e.g. SLACK_BOT_TOKEN). Values are encrypted at rest
 * using SHIPWRIGHT_ENCRYPTION_KEY (AES-256-GCM).
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import {
  AnthropicCredentialsBlockedError,
  anthropicCredentialKeysIn,
} from "./anthropic-credential-guard.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { ApiError, UnprocessableEntityError } from "./errors.ts";
import type { TokenCrypto } from "./token-crypto.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentEnvBundle {
  /** All stored env vars (decrypted). */
  env: Record<string, string>;
  agentId: string;
  /** Enabled tool patterns for this agent. */
  allowedTools: string[];
}

export interface AgentEnvEntry {
  agentId: string;
  env: Record<string, string>;
}

/**
 * Return type for getByAgentId().
 * Secret values are masked as "***" in env; their keys are listed in secretKeys.
 */
interface AgentEnvResult {
  env: Record<string, string>;
  secretKeys: string[];
  /** ATP-2.4: row source per key (`template` | `custom`). */
  sources?: Record<string, string>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AgentEnvService {
  constructor(
    private prisma: PrismaClient,
    private crypto: TokenCrypto,
    private clock: Clock = SystemClock(),
    /** WIF-2.1: block Anthropic credential keys for non-self-hosted agents. */
    private anthropicFederationEnabled = false,
  ) {}

  /**
   * Reject Anthropic credential keys for a federated (non-self-hosted) agent.
   * Every write path (API, admin UI, createAgent, Slack/GitHub provisioning)
   * goes through upsert/patch, so this is the single enforcement point.
   */
  private assertNoBlockedCredentials(
    agent: { selfHosted: boolean },
    env: Record<string, string>,
  ): void {
    if (!this.anthropicFederationEnabled || agent.selfHosted) return;
    const blocked = anthropicCredentialKeysIn(Object.keys(env));
    if (blocked.length > 0) throw new AnthropicCredentialsBlockedError(blocked);
  }

  /**
   * Replace all env vars for the given agent (delete existing + insert new).
   * Validates that agentId references an existing Agent.
   *
   * @param secretKeys - optional set of key names to mark as secret
   */
  async upsert(
    agentId: string,
    env: Record<string, string>,
    secretKeys?: Set<string>,
  ): Promise<void> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) {
      throw new UnprocessableEntityError("agent not found");
    }
    this.assertNoBlockedCredentials(agent, env);

    const now = this.clock.now();
    const keys = Object.keys(env);

    // ATP-1.2: a template row the caller omits is a deletion, so it becomes a
    // tombstone; tombstones the caller does not mention are kept.
    await this.prisma.$transaction([
      this.prisma.agentEnv.updateMany({
        where: {
          agentId,
          source: "template",
          enabled: true,
          key: { notIn: keys },
        },
        data: { enabled: false, source: "custom", updatedAt: now },
      }),
      this.prisma.agentEnv.deleteMany({
        where: { agentId, OR: [{ enabled: true }, { key: { in: keys } }] },
      }),
      ...Object.entries(env).map(([key, value]) =>
        this.prisma.agentEnv.create({
          data: {
            agentId,
            key,
            value: this.crypto.encrypt(value),
            secret: secretKeys?.has(key) ?? false,
            source: "custom",
            updatedAt: now,
          },
        }),
      ),
    ]);
  }

  /**
   * Upsert specific keys for the given agent without touching other keys.
   * Validates that agentId references an existing Agent.
   *
   * @param secretKeys - optional set of key names to mark as secret
   */
  async patch(
    agentId: string,
    env: Record<string, string>,
    secretKeys?: Set<string>,
  ): Promise<void> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) {
      throw new UnprocessableEntityError("agent not found");
    }
    this.assertNoBlockedCredentials(agent, env);

    const now = this.clock.now();
    await this.prisma.$transaction(
      Object.entries(env).map(([key, value]) =>
        this.prisma.agentEnv.upsert({
          where: { agentId_key: { agentId, key } },
          create: {
            agentId,
            key,
            value: this.crypto.encrypt(value),
            secret: secretKeys?.has(key) ?? false,
            source: "custom",
            updatedAt: now,
          },
          update: {
            value: this.crypto.encrypt(value),
            secret: secretKeys?.has(key) ?? false,
            // An admin edit takes ownership and re-enables a tombstone.
            source: "custom",
            enabled: true,
            updatedAt: now,
          },
        }),
      ),
    );
  }

  /**
   * Internal reconcile write path (ATP-1.2); never exposed over HTTP.
   * Upserts template-owned keys with source="template" without flipping
   * source. Keys that are already custom (user edits or tombstones of deleted
   * template rows) are left untouched so a reconcile never overrides or
   * re-adds them.
   */
  async patchFromTemplate(
    agentId: string,
    env: Record<string, string>,
    secretKeys?: Set<string>,
  ): Promise<void> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) {
      throw new UnprocessableEntityError("agent not found");
    }
    this.assertNoBlockedCredentials(agent, env);

    const customKeys = new Set(
      (
        await this.prisma.agentEnv.findMany({
          where: { agentId, source: "custom" },
          select: { key: true },
        })
      ).map((r) => r.key),
    );
    const now = this.clock.now();
    await this.prisma.$transaction(
      Object.entries(env)
        .filter(([key]) => !customKeys.has(key))
        .map(([key, value]) => {
          const data = {
            value: this.crypto.encrypt(value),
            secret: secretKeys?.has(key) ?? false,
            source: "template",
            updatedAt: now,
          };
          return this.prisma.agentEnv.upsert({
            where: { agentId_key: { agentId, key } },
            create: { agentId, key, ...data },
            update: data,
          });
        }),
    );
  }

  /**
   * Get all env vars for an agent.
   * Secret values are masked as "***"; their keys are listed in secretKeys.
   * Returns null if the agent has no env vars set.
   */
  async getByAgentId(agentId: string): Promise<AgentEnvResult | null> {
    const rows = await this.prisma.agentEnv.findMany({
      where: { agentId, enabled: true },
    });
    if (rows.length === 0) return null;

    const env: Record<string, string> = {};
    const secretKeys: string[] = [];
    const sources: Record<string, string> = {};

    for (const row of rows) {
      sources[row.key] = row.source;
      if (row.secret) {
        env[row.key] = "***";
        secretKeys.push(row.key);
      } else {
        env[row.key] = this.crypto.decrypt(row.value);
      }
    }

    return { env, secretKeys, sources };
  }

  /**
   * Returns the full env bundle for an agent — stored env vars (decrypted) plus
   * allowed tools. Always decrypts regardless of the secret flag.
   *
   * Returns null if the agent has no env vars set.
   * Throws 500 if decryption fails.
   */
  async getConfigBundle(agentId: string): Promise<AgentEnvBundle | null> {
    const rows = await this.prisma.agentEnv.findMany({
      where: { agentId, enabled: true },
    });
    if (rows.length === 0) return null;

    let env: Record<string, string>;
    try {
      // Always decrypt — secret flag only affects the admin API response
      env = this.decryptRows(rows);
    } catch (err) {
      console.error("[shipwright agent] failed to decrypt agent env vars", err);
      throw new ApiError(500, "failed to decrypt agent env vars");
    }

    const tools = await this.prisma.agentTool.findMany({
      where: { agentId, enabled: true },
    });

    return {
      env,
      agentId,
      allowedTools: tools.map((t: { pattern: string }) => t.pattern),
    };
  }

  /**
   * Delete a single env var key for the given agent.
   * No-ops if the key does not exist. A template-sourced row becomes a
   * disabled custom tombstone (ATP-1.2) so a later reconcile does not re-add
   * it; a custom row is removed.
   */
  async deleteKey(agentId: string, key: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.agentEnv.updateMany({
        where: { agentId, key, source: "template" },
        data: { enabled: false, source: "custom", updatedAt: this.clock.now() },
      }),
      this.prisma.agentEnv.deleteMany({
        where: { agentId, key, source: "custom", enabled: true },
      }),
    ]);
  }

  /**
   * List all agents with their decrypted env vars.
   */
  async listAll(): Promise<AgentEnvEntry[]> {
    const rows = await this.prisma.agentEnv.findMany({
      where: { enabled: true },
    });

    // Group by agentId
    const byAgent = new Map<string, typeof rows>();
    for (const row of rows) {
      const existing = byAgent.get(row.agentId) ?? [];
      existing.push(row);
      byAgent.set(row.agentId, existing);
    }

    return Array.from(byAgent.entries()).map(([agentId, agentRows]) => ({
      agentId,
      env: this.decryptRows(agentRows),
    }));
  }

  private decryptRows(
    rows: Array<{ key: string; value: string }>,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const row of rows) {
      env[row.key] = this.crypto.decrypt(row.value);
    }
    return env;
  }
}
