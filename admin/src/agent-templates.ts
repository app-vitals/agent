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
}

export interface TemplateView {
  id: string;
  accountId: string | null;
  specialty: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: TemplateItemView[];
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
  }[];
};

export class AgentTemplateService {
  constructor(
    private prisma: PrismaClient,
    private crypto: TokenCrypto,
    private specialtyRegistry: Pick<SpecialtyTypeResolver, "tryGetType">,
  ) {}

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
        return { kind, key: it.key, payload, updatedAt: it.updatedAt };
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

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.agentTemplate.findFirst({
          where: { accountId, specialty },
          include: { items: true },
        });
        const stored = new Map(
          (existing?.items ?? []).map((it) => [`${it.kind}:${it.key}`, it]),
        );
        const data = items.map((item) => ({
          kind: item.kind,
          key: item.key,
          payload: this.seal(
            item,
            stored.get(`${item.kind}:${item.key}`)?.payload,
          ),
        }));

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
    return this.get(actor, templateId);
  }

  /** Remove one item; 404 when the template or the item does not exist. */
  async deleteItem(
    actor: TemplateActor,
    templateId: string,
    kind: AgentTemplateItemKind,
    key: string,
  ): Promise<void> {
    await this.load(actor, templateId);
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
  }

  /** Delete a template and (by cascade) its items. */
  async delete(actor: TemplateActor, id: string): Promise<void> {
    await this.load(actor, id);
    await this.prisma.agentTemplate.delete({ where: { id } });
  }
}
