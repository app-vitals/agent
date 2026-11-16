/**
 * admin/src/agent-marketplaces.ts
 * AgentMarketplaceService — CRUD for remote Claude Code plugin marketplaces
 * per agent.
 *
 * A marketplace is identified by `name` (the name plugins reference after the
 * "@" in "<plugin>@<marketplace>") and points at a `source`: a GitHub
 * "owner/repo" or an https git URL, optionally pinned to a `ref`. The unique
 * constraint on [agentId, name] makes two versions of one marketplace
 * impossible; upsert() re-points an existing name.
 *
 * Input is validated here (422) rather than in the Zod request schema, which
 * would answer 400: `source` and `ref` end up as arguments to `git`/`claude`
 * in the runtime, so anything that could be read as an option, a local path,
 * or a credential-bearing URL is refused.
 */

import type {
  AgentMarketplace,
  PrismaClient,
} from "../prisma/client/client.ts";
import { NotFoundError, UnprocessableEntityError } from "./errors.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

export type { AgentMarketplace };

const GITHUB_SHORTHAND =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** Throws UnprocessableEntityError unless `source` is `owner/repo` or an https git URL. */
export function validateMarketplaceSource(source: string): void {
  if (GITHUB_SHORTHAND.test(source)) return;
  if (source.startsWith("https://") && !/\s/.test(source)) {
    try {
      const url = new URL(source);
      if (
        url.protocol === "https:" &&
        HOST.test(url.hostname) &&
        url.username === "" &&
        url.password === "" &&
        url.pathname.length > 1
      ) {
        return;
      }
    } catch {
      // fall through to the 422 below
    }
  }
  throw new UnprocessableEntityError(
    "source must be a GitHub 'owner/repo' or an https git URL without credentials",
  );
}

/** Throws UnprocessableEntityError unless `name` is a plain marketplace name. */
export function validateMarketplaceName(name: string): void {
  if (!NAME.test(name)) {
    throw new UnprocessableEntityError(
      "name must start with a letter or digit and contain only letters, digits, '.', '_' and '-'",
    );
  }
}

/** Throws UnprocessableEntityError for a ref that is not a plain branch, tag or sha. */
export function validateMarketplaceRef(ref: string | null | undefined): void {
  if (ref === undefined || ref === null) return;
  if (!REF.test(ref) || ref.includes("..")) {
    throw new UnprocessableEntityError(
      "ref must be a plain branch, tag or sha",
    );
  }
}

export class AgentMarketplaceService {
  constructor(private prisma: PrismaClient) {}

  /** List all marketplaces for a given agent, ordered by createdAt. */
  async list(agentId: string): Promise<AgentMarketplace[]> {
    return this.prisma.agentMarketplace.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Add a marketplace for the agent, or re-point the existing one with the
   * same name at a new source/ref. Throws UnprocessableEntityError on invalid
   * input.
   */
  async upsert(
    agentId: string,
    input: { name: string; source: string; ref?: string | null },
  ): Promise<AgentMarketplace> {
    const { name, source } = input;
    const ref = input.ref ?? null;
    validateMarketplaceName(name);
    validateMarketplaceSource(source);
    validateMarketplaceRef(ref);
    return this.prisma.agentMarketplace.upsert({
      where: { agentId_name: { agentId, name } },
      create: {
        agentId,
        name,
        source,
        ref,
        rowSource: "custom",
        enabled: true,
      },
      update: { source, ref, rowSource: "custom", enabled: true },
    });
  }

  /**
   * Internal reconcile write path (TMK-2.1); never exposed over HTTP.
   * Creates a template-owned marketplace, or refreshes one that is still
   * template-owned. A custom row (user edit or tombstone) is returned
   * untouched. Validates input as upsert() does.
   */
  async addFromTemplate(
    agentId: string,
    input: { name: string; source: string; ref?: string | null },
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentMarketplace> {
    const { name, source } = input;
    const ref = input.ref ?? null;
    validateMarketplaceName(name);
    validateMarketplaceSource(source);
    validateMarketplaceRef(ref);
    const existing = await client.agentMarketplace.findUnique({
      where: { agentId_name: { agentId, name } },
    });
    if (existing?.rowSource === "custom") return existing;
    return client.agentMarketplace.upsert({
      where: { agentId_name: { agentId, name } },
      create: {
        agentId,
        name,
        source,
        ref,
        rowSource: "template",
        enabled: true,
      },
      update: { source, ref, rowSource: "template", enabled: true },
    });
  }

  /**
   * Remove a marketplace by ID. Verifies agentId ownership before deleting.
   * Throws NotFoundError if the id doesn't exist or belongs to another agent.
   */
  async remove(agentId: string, marketplaceId: string): Promise<void> {
    const existing = await this.prisma.agentMarketplace.findUnique({
      where: { id: marketplaceId },
    });
    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`marketplace ${marketplaceId} not found`);
    }
    if (existing.rowSource === "template") {
      // Tombstone so a later reconcile does not re-add the row.
      await this.prisma.agentMarketplace.update({
        where: { id: marketplaceId },
        data: { enabled: false, rowSource: "custom" },
      });
      return;
    }
    await this.prisma.agentMarketplace.delete({ where: { id: marketplaceId } });
  }
}
