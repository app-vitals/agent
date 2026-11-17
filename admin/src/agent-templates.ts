/**
 * admin/src/agent-templates.ts
 * AgentTemplateService (ATP-1.3) — CRUD for agent templates and their items.
 *
 * A template is the default env/tool/plugin/cron set for one scope:
 * (accountId | null = deployment-wide, specialty | null = every specialty).
 * Items are keyed by (kind, key): env var name, tool pattern, plugin name or
 * cron name.
 *
 * Authorization is part of the service so every caller shares it: a platform
 * admin ("admin" actor) manages any template; an account-scoped caller
 * ("account" actor) manages only that account's templates. A template outside
 * the actor's account reads as 404 (no existence leak); naming another
 * account, or the deployment scope, in a request is 403.
 *
 * Env values are encrypted at rest (sealTemplateItemPayload) and secret ones
 * are masked as "***" on every read; non-secret ones are returned decrypted.
 */

import { z } from "zod";
import type { PrismaClient } from "../prisma/client/client.ts";
import {
  AGENT_TEMPLATE_ITEM_KINDS,
  assertMarketplaceTemplateItem,
  type AgentTemplateItemKind,
  assertTemplateEnvKeyAllowed,
  openTemplateItemPayload,
  sealTemplateItemPayload,
  type TemplateItemPayload,
} from "./agent-template-items.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.ts";
import type { SpecialtyTypeResolver } from "./specialty-types.ts";
import type { TokenCrypto } from "./token-crypto.ts";

export const SECRET_MASK = "***";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type TemplateActor =
  | { kind: "admin" }
  | { kind: "account"; accountId: string };

export interface TemplateItemInput {
  kind: AgentTemplateItemKind;
  key: string;
  payload?: Record<string, unknown>;
}

export interface TemplateScopeInput {
  /** Omitted = the actor's own account (account actors) / deployment-wide (admins). */
  accountId?: string | null;
  specialty?: string | null;
}

export interface TemplateItemView {
  kind: AgentTemplateItemKind;
  key: string;
  payload: Record<string, unknown>;
  updatedAt: Date;
  /**
   * TMK-3.2: who owns the item ("helm" = SHIPWRIGHT_TEMPLATE_SEED). Absent for
   * hand-added items. Optional so the exported shape stays additive.
   */
  managedBy?: string;
}

export interface TemplateView {
  id: string;
  accountId: string | null;
  specialty: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: TemplateItemView[];
}

/** Outcome of AgentTemplateService.applyManagedItems() (TMK-3.2). */
export interface ManagedItemsResult {
  /** The deployment-wide template; null when none existed and none was needed. */
  templateId: string | null;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Managed items not applied because a hand-added item holds the key. */
  skipped: { kind: AgentTemplateItemKind; key: string }[];
}

/**
 * pg_advisory_xact_lock key serializing applyManagedItems() across admin
 * replicas ("TMK2" as a 32-bit integer). Constant so every replica contends
 * on the same lock.
 */
export const MANAGED_ITEMS_LOCK_KEY = 0x544d4b32;

/** Deep JSON equality that ignores object key order (jsonb reorders keys). */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, x]) => [k, canon(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// ─── Per-kind payload shapes ──────────────────────────────────────────────────

const nonEmpty = z.string().trim().min(1);

const PAYLOAD_SCHEMAS = {
  env: z.object({ value: z.string(), secret: z.boolean().optional() }),
  tool: z.object({ enabled: z.boolean().optional() }),
  plugin: z.object({
    version: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  }),
  cron: z.object({
    schedule: nonEmpty,
    prompt: nonEmpty,
    channel: z.string().nullable().optional(),
    user: z.string().nullable().optional(),
    silent: z.boolean().optional(),
    enabled: z.boolean().optional(),
    preCheck: z.string().nullable().optional(),
  }),
  marketplace: z.object({
    source: z.string(),
    ref: z.string().nullable().optional(),
  }),
} satisfies Record<AgentTemplateItemKind, z.ZodType>;

/** Validates one item and returns its normalized (still plaintext) payload. */
export function normalizeTemplateItem(
  item: TemplateItemInput,
): TemplateItemInput & { payload: Record<string, unknown> } {
  if (!AGENT_TEMPLATE_ITEM_KINDS.includes(item.kind)) {
    throw new UnprocessableEntityError(`unknown item kind ${item.kind}`);
  }
  const key = item.key.trim();
  if (key === "") {
    throw new UnprocessableEntityError(
      item.kind === "cron"
        ? "cron template items need a stable name key"
        : `${item.kind} template items need a key`,
    );
  }
  if (item.kind === "env") {
    if (!ENV_KEY.test(key)) {
      throw new UnprocessableEntityError(
        `env key ${key} must be a valid environment variable name`,
      );
    }
    assertTemplateEnvKeyAllowed(key);
  }
  const defaults = item.kind === "tool" ? {} : undefined;
  const parsed = PAYLOAD_SCHEMAS[item.kind].safeParse(
    item.payload ?? defaults ?? {},
  );
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "payload"}: ${i.message}`)
      .join(", ");
    throw new UnprocessableEntityError(
      `invalid ${item.kind} item ${key}: ${detail}`,
    );
  }
  if (item.kind === "marketplace") {
    assertMarketplaceTemplateItem(
      key,
      parsed.data as { source: string; ref?: string | null },
    );
  }
  return { kind: item.kind, key, payload: parsed.data };
}

// ─── Service ──────────────────────────────────────────────────────────────────

type TemplateRow = {
  id: string;
  accountId: string | null;
  specialty: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: {
    kind: string;
    key: string;
    payload: unknown;
    updatedAt: Date;
    managedBy?: string | null;
  }[];
};

export class AgentTemplateService {
  constructor(
    private prisma: PrismaClient,
    private crypto: TokenCrypto,
    private specialtyRegistry: Pick<SpecialtyTypeResolver, "tryGetType">,
    /**
     * ATP-2.2: applies a template write to the agents that follow it. Optional
     * (additive); absent means template writes are not propagated.
     */
    private fanOut?: {
      reconcileScope(scope: {
        accountId: string | null;
        specialty: string | null;
      }): Promise<unknown>;
    },
  ) {}

  /** Best-effort fan-out: the template write already committed. */
  private async propagate(scope: {
    accountId: string | null;
    specialty: string | null;
  }): Promise<void> {
    if (!this.fanOut) return;
    try {
      await this.fanOut.reconcileScope(scope);
    } catch (err) {
      console.error(
        "template fan-out failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private toView(row: TemplateRow): TemplateView {
    const items = [...row.items]
      .sort((a, b) =>
        a.kind === b.kind
          ? a.key.localeCompare(b.key)
          : a.kind.localeCompare(b.kind),
      )
      .map((it): TemplateItemView => {
        const kind = it.kind as AgentTemplateItemKind;
        const stored = (it.payload ?? {}) as TemplateItemPayload;
        let payload: Record<string, unknown>;
        if (kind === "env" && stored.secret === true) {
          payload = { ...stored, value: SECRET_MASK };
        } else {
          payload = openTemplateItemPayload(kind, stored, this.crypto);
        }
        return {
          kind,
          key: it.key,
          payload,
          updatedAt: it.updatedAt,
          ...(it.managedBy ? { managedBy: it.managedBy } : {}),
        };
      });
    return {
      id: row.id,
      accountId: row.accountId,
      specialty: row.specialty,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      items,
    };
  }

  /** Throws 404 unless the actor may see `template`. */
  private assertVisible(
    actor: TemplateActor,
    template: { id: string; accountId: string | null },
  ): void {
    if (actor.kind === "account" && template.accountId !== actor.accountId) {
      throw new NotFoundError(`template ${template.id} not found`);
    }
  }

  private async load(actor: TemplateActor, id: string): Promise<TemplateRow> {
    const row = await this.prisma.agentTemplate.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!row) throw new NotFoundError(`template ${id} not found`);
    this.assertVisible(actor, row);
    return row;
  }

  private validateSpecialty(specialty: string | null): void {
    if (specialty !== null && !this.specialtyRegistry.tryGetType(specialty)) {
      throw new UnprocessableEntityError(`unknown specialty ${specialty}`);
    }
  }

  /**
   * The payload to store for `item`. A secret env item sent as the mask keeps
   * `prior` (the stored payload of the same key); with nothing to keep it is a
   * 422.
   */
  private seal(
    item: TemplateItemInput & { payload: Record<string, unknown> },
    prior: unknown,
  ): TemplateItemPayload {
    if (
      item.kind === "env" &&
      item.payload.secret === true &&
      item.payload.value === SECRET_MASK
    ) {
      const kept = prior as TemplateItemPayload | undefined;
      if (kept?.secret !== true) {
        throw new UnprocessableEntityError(
          `env ${item.key}: "${SECRET_MASK}" is the mask for an existing secret; send the real value`,
        );
      }
      return kept;
    }
    return sealTemplateItemPayload(
      item.kind,
      item.payload as TemplateItemPayload,
      this.crypto,
    );
  }

  /**
   * List templates. An account actor sees only its own account's templates
   * (naming another account is 403); an admin sees all, optionally narrowed.
   */
  async list(
    actor: TemplateActor,
    filter: { accountId?: string; specialty?: string } = {},
  ): Promise<TemplateView[]> {
    if (
      actor.kind === "account" &&
      filter.accountId !== undefined &&
      filter.accountId !== actor.accountId
    ) {
      throw new ForbiddenError("cannot access another account's templates");
    }
    const accountId =
      actor.kind === "account" ? actor.accountId : filter.accountId;
    const rows = await this.prisma.agentTemplate.findMany({
      where: {
        ...(accountId !== undefined ? { accountId } : {}),
        ...(filter.specialty !== undefined
          ? { specialty: filter.specialty }
          : {}),
      },
      include: { items: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.toView(r));
  }

  async get(actor: TemplateActor, id: string): Promise<TemplateView> {
    return this.toView(await this.load(actor, id));
  }

  /**
   * Create the template for the scope, or replace the items of the existing
   * one. A secret env item sent with the mask "***" keeps the stored value of
   * the same key (so a GET → edit → PUT round trip does not need the secret).
   */
  async replace(
    actor: TemplateActor,
    scopeInput: TemplateScopeInput,
    itemsInput: TemplateItemInput[],
  ): Promise<{ template: TemplateView; created: boolean }> {
    let accountId: string | null;
    if (actor.kind === "account") {
      if (
        scopeInput.accountId !== undefined &&
        scopeInput.accountId !== actor.accountId
      ) {
        throw new ForbiddenError(
          "cannot manage another account's or deployment-wide templates",
        );
      }
      accountId = actor.accountId;
    } else {
      accountId = scopeInput.accountId ?? null;
    }
    const specialty = scopeInput.specialty ?? null;
    this.validateSpecialty(specialty);

    const seen = new Set<string>();
    const items = itemsInput.map((raw) => {
      const item = normalizeTemplateItem(raw);
      const id = `${item.kind}:${item.key}`;
      if (seen.has(id)) {
        throw new UnprocessableEntityError(
          `duplicate ${item.kind} item key ${item.key}`,
        );
      }
      seen.add(id);
      return item;
    });

    if (accountId !== null) {
      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true },
      });
      if (!account) {
        throw new UnprocessableEntityError(`account ${accountId} not found`);
      }
    }

    let outcome: { template: TemplateView; created: boolean };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.agentTemplate.findFirst({
          where: { accountId, specialty },
          include: { items: true },
        });
        const stored = new Map(
          (existing?.items ?? []).map((it) => [`${it.kind}:${it.key}`, it]),
        );
        // A replaced item keeps its owner (TMK-3.2): an edited seeded item
        // keeps its badge and is overwritten again on the next admin boot.
        const data = items.map((item) => {
          const prior = stored.get(`${item.kind}:${item.key}`);
          return {
            kind: item.kind,
            key: item.key,
            payload: this.seal(item, prior?.payload),
            managedBy: prior?.managedBy ?? null,
          };
        });

        const templateId = existing
          ? existing.id
          : (await tx.agentTemplate.create({ data: { accountId, specialty } }))
              .id;
        if (existing) {
          await tx.agentTemplateItem.deleteMany({ where: { templateId } });
          await tx.agentTemplate.update({
            where: { id: templateId },
            data: { updatedAt: new Date() },
          });
        }
        if (data.length > 0) {
          await tx.agentTemplateItem.createMany({
            data: data.map((d) => ({ ...d, templateId })),
          });
        }
        const row = await tx.agentTemplate.findUniqueOrThrow({
          where: { id: templateId },
          include: { items: true },
        });
        return { template: this.toView(row), created: !existing };
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        throw new ConflictError(
          "a template for this scope was created concurrently; retry",
        );
      }
      throw err;
    }
    await this.propagate({ accountId, specialty });
    return outcome;
  }

  /** Add or replace one item of a template. */
  async putItem(
    actor: TemplateActor,
    templateId: string,
    input: TemplateItemInput,
  ): Promise<TemplateView> {
    const existing = await this.load(actor, templateId);
    const item = normalizeTemplateItem(input);
    const prior = existing.items.find(
      (it) => it.kind === item.kind && it.key === item.key,
    );
    const payload = this.seal(item, prior?.payload);
    await this.prisma.$transaction([
      this.prisma.agentTemplateItem.upsert({
        where: {
          templateId_kind_key: {
            templateId,
            kind: item.kind,
            key: item.key,
          },
        },
        create: { templateId, kind: item.kind, key: item.key, payload },
        update: { payload },
      }),
      this.prisma.agentTemplate.update({
        where: { id: templateId },
        data: { updatedAt: new Date() },
      }),
    ]);
    await this.propagate(existing);
    return this.get(actor, templateId);
  }

  /** Remove one item; 404 when the template or the item does not exist. */
  async deleteItem(
    actor: TemplateActor,
    templateId: string,
    kind: AgentTemplateItemKind,
    key: string,
  ): Promise<void> {
    const existing = await this.load(actor, templateId);
    const { count } = await this.prisma.agentTemplateItem.deleteMany({
      where: { templateId, kind, key },
    });
    if (count === 0) {
      throw new NotFoundError(`${kind} item ${key} not found`);
    }
    await this.prisma.agentTemplate.update({
      where: { id: templateId },
      data: { updatedAt: new Date() },
    });
    await this.propagate(existing);
  }

  /**
   * TMK-3.2: make the deployment-wide, all-specialties template hold exactly
   * `itemsInput` among the items `managedBy` owns for `kinds`, creating the
   * template if absent. In one transaction under a constant advisory lock, so
   * concurrent admin replicas serialize and end with one copy of each item:
   *
   * - each item is created, or updated in place, with `managedBy`;
   * - items owned by `managedBy` of a listed kind that are not in
   *   `itemsInput` are deleted;
   * - hand-added items (`managedBy` null) are never touched; a managed item
   *   whose key a hand-added item already holds is reported in `skipped`.
   *
   * Items go through normalizeTemplateItem() (the same validation as the API)
   * before anything is written. The fan-out to agents runs after commit,
   * whether or not this pass changed rows, so a boot also repairs a fan-out
   * an earlier boot did not finish.
   */
  async applyManagedItems(
    managedBy: string,
    kinds: readonly AgentTemplateItemKind[],
    itemsInput: TemplateItemInput[],
  ): Promise<ManagedItemsResult> {
    const seen = new Set<string>();
    const items = itemsInput.map((raw) => {
      const item = normalizeTemplateItem(raw);
      if (!kinds.includes(item.kind)) {
        throw new UnprocessableEntityError(
          `${item.kind} item ${item.key} is not a managed kind`,
        );
      }
      const id = `${item.kind}:${item.key}`;
      if (seen.has(id)) {
        throw new UnprocessableEntityError(
          `duplicate ${item.kind} item key ${item.key}`,
        );
      }
      seen.add(id);
      return item;
    });

    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MANAGED_ITEMS_LOCK_KEY}::bigint)::text`;
        const scope = { accountId: null, specialty: null };
        const existing = await tx.agentTemplate.findFirst({
          where: scope,
          include: { items: true },
        });
        const out: ManagedItemsResult = {
          templateId: existing?.id ?? null,
          created: 0,
          updated: 0,
          unchanged: 0,
          deleted: 0,
          skipped: [],
        };
        if (!existing && items.length === 0) return out;
        const templateId =
          existing?.id ?? (await tx.agentTemplate.create({ data: scope })).id;
        out.templateId = templateId;
        const stored = new Map(
          (existing?.items ?? []).map((it) => [`${it.kind}:${it.key}`, it]),
        );

        for (const item of items) {
          const prior = stored.get(`${item.kind}:${item.key}`);
          if (prior && prior.managedBy === null) {
            out.skipped.push({ kind: item.kind, key: item.key });
            continue;
          }
          const payload = this.seal(item, prior?.payload);
          if (!prior) {
            await tx.agentTemplateItem.create({
              data: {
                templateId,
                kind: item.kind,
                key: item.key,
                payload,
                managedBy,
              },
            });
            out.created++;
          } else if (
            prior.managedBy === managedBy &&
            sameJson(prior.payload, payload)
          ) {
            out.unchanged++;
          } else {
            await tx.agentTemplateItem.update({
              where: { id: prior.id },
              data: { payload, managedBy },
            });
            out.updated++;
          }
        }

        const stale = (existing?.items ?? []).filter(
          (it) =>
            it.managedBy === managedBy &&
            (kinds as readonly string[]).includes(it.kind) &&
            !seen.has(`${it.kind}:${it.key}`),
        );
        if (stale.length > 0) {
          await tx.agentTemplateItem.deleteMany({
            where: { id: { in: stale.map((it) => it.id) } },
          });
          out.deleted = stale.length;
        }
        if (existing && out.created + out.updated + out.deleted > 0) {
          await tx.agentTemplate.update({
            where: { id: templateId },
            data: { updatedAt: new Date() },
          });
        }
        return out;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    if (result.templateId !== null) {
      await this.propagate({ accountId: null, specialty: null });
    }
    return result;
  }

  /** Delete a template and (by cascade) its items. */
  async delete(actor: TemplateActor, id: string): Promise<void> {
    const existing = await this.load(actor, id);
    await this.prisma.agentTemplate.delete({ where: { id } });
    await this.propagate(existing);
  }
}
