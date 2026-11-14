/**
 * admin/src/agent-template-reconcile.ts
 * ATP-2.1: per-agent template reconcile — the generalization of
 * reconcileSystemCrons() (agent-cron-jobs.ts) to env, tools, plugins and
 * crons.
 *
 * reconcile(agentId) resolves the agent's merged template
 * (agent-template-merge.ts: specialty defaults, deployment/all,
 * deployment/type, account/all, account/type) and applies it in ONE
 * transaction, so a failure leaves no partial writes:
 *
 * - Missing items are created with source="template".
 * - Rows with source="template" track the template: edited in place (ids
 *   stay stable), and deleted once no layer defines their key (orphans).
 * - Rows with source="custom" are never modified. That covers admin edits and
 *   tombstones (ATP-1.2 turns a deleted template row into enabled=false,
 *   source=custom), so a deleted inherited row is never re-added.
 * - Adoption: an enabled custom row whose value already equals the template
 *   value becomes source="template" (existing agents start all-custom). A
 *   same-named user cron is adopted only when schedule and prompt match;
 *   otherwise it is left alone and reported in `conflicts`.
 * - The specialty's default crons stay system crons (system=true), applied
 *   through applySystemCronDefaults(); a template cron with the same name
 *   overrides the default's fields in place.
 * - The tool rows are never reduced to zero enabled patterns (the runtime
 *   ignores an empty allowedTools); such removals are skipped and flagged.
 * - The specialty is read on every run, so a changed specialty re-resolves:
 *   the old type's template rows become orphans, the new type's are added.
 * - A detached agent (Agent.templateDetached) and an agent whose specialty is
 *   neither built in nor extension-supplied are left untouched.
 *
 * Only payload fields a cron template item actually sets are tracked on an
 * existing row; unset fields take their defaults on create only.
 */

import type {
  AgentCronJob,
  AgentEnv,
  AgentPlugin,
  AgentTool,
  PrismaClient,
} from "../prisma/client/client.ts";
import { applySystemCronDefaults, isValidCron } from "./agent-cron-jobs.ts";
import {
  type AgentTemplateItemKind,
  openTemplateItemPayload,
  TEMPLATE_ENV_DENYLIST,
  type TemplateItemPayload,
} from "./agent-template-items.ts";
import {
  type MergedTemplate,
  type MergedTemplateItem,
  mergeTemplateLayers,
  resolveSpecialtyDefaultSet,
  specialtyDefaultLayer,
  type TemplateLayerInput,
  templateLayerForScope,
} from "./agent-template-merge.ts";
import { NotFoundError } from "./errors.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";
import type {
  SpecialtyDefaultCron,
  SpecialtyDefaultsResolver,
} from "./specialty-defaults.ts";
import type { SpecialtyTypeResolver } from "./specialty-types.ts";
import type { TokenCrypto } from "./token-crypto.ts";

export interface TemplateReconcileCounts {
  created: number;
  updated: number;
  adopted: number;
  deleted: number;
}

export interface TemplateReconcileConflict {
  kind: AgentTemplateItemKind;
  key: string;
  reason: "cron_name_conflict" | "invalid_cron_schedule" | "denylisted_env_key";
}

export interface TemplateReconcileResult {
  agentId: string;
  /** "detached" / "unknown_specialty": nothing was written. */
  status: "reconciled" | "detached" | "unknown_specialty";
  /** Template-tracked rows (system crons are counted in `systemCrons`). */
  counts: Record<AgentTemplateItemKind, TemplateReconcileCounts>;
  systemCrons: { created: number; updated: number; deleted: number };
  /** Template items deliberately not applied. */
  conflicts: TemplateReconcileConflict[];
  /** True when tool removals/disables were skipped to keep one enabled tool. */
  toolsEmptyGuarded: boolean;
}

const zeroCounts = (): TemplateReconcileCounts => ({
  created: 0,
  updated: 0,
  adopted: 0,
  deleted: 0,
});

function emptyResult(
  agentId: string,
  status: TemplateReconcileResult["status"],
): TemplateReconcileResult {
  return {
    agentId,
    status,
    counts: {
      env: zeroCounts(),
      tool: zeroCounts(),
      plugin: zeroCounts(),
      cron: zeroCounts(),
    },
    systemCrons: { created: 0, updated: 0, deleted: 0 },
    conflicts: [],
    toolsEmptyGuarded: false,
  };
}

const enabledOf = (payload: Record<string, unknown>): boolean =>
  payload.enabled !== false;

const versionOf = (payload: Record<string, unknown>): string | null =>
  typeof payload.version === "string" ? payload.version : null;

/** Cron row fields a template item may set, in row column names. */
const CRON_FIELDS = [
  "schedule",
  "prompt",
  "channel",
  "user",
  "silent",
  "preCheck",
  "enabled",
] as const;
type CronField = (typeof CRON_FIELDS)[number];
type CronFields = { [K in CronField]?: AgentCronJob[K] };

/** The row fields `payload` sets (absent keys are not tracked). */
function cronFieldsOf(payload: Record<string, unknown>): CronFields {
  const out: CronFields = {};
  if (typeof payload.schedule === "string") out.schedule = payload.schedule;
  if (typeof payload.prompt === "string") out.prompt = payload.prompt;
  if ("channel" in payload) out.channel = (payload.channel as string) ?? null;
  if ("user" in payload) out.user = (payload.user as string) ?? null;
  if (typeof payload.silent === "boolean") out.silent = payload.silent;
  if ("preCheck" in payload) {
    out.preCheck = (payload.preCheck as string) ?? null;
  }
  if (typeof payload.enabled === "boolean") out.enabled = payload.enabled;
  return out;
}

/** The subset of `want` that differs from `row`. */
function cronDiff(row: AgentCronJob, want: CronFields): CronFields {
  const diff: CronFields = {};
  for (const field of CRON_FIELDS) {
    const value = want[field];
    if (value === undefined) continue;
    // A lockdown-disabled cron stays disabled until the lockdown lifts.
    if (field === "enabled" && row.lockdownDisabledAt !== null) continue;
    if (row[field] !== value) Object.assign(diff, { [field]: value });
  }
  return diff;
}

export class AgentTemplateReconcileService {
  constructor(
    private prisma: PrismaClient,
    private crypto: TokenCrypto,
    private specialtyRegistry: Pick<SpecialtyTypeResolver, "tryGetType">,
    private specialtyDefaults: SpecialtyDefaultsResolver = () => undefined,
  ) {}

  /** Reconcile one agent against its merged template, in one transaction. */
  async reconcile(agentId: string): Promise<TemplateReconcileResult> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent reconciles of the same agent.
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE`;
      const agent = await tx.agent.findUnique({
        where: { id: agentId },
        select: { specialty: true, accountId: true, templateDetached: true },
      });
      if (!agent) throw new NotFoundError(`agent ${agentId} not found`);
      if (agent.templateDetached) return emptyResult(agentId, "detached");

      const defaults = resolveSpecialtyDefaultSet(
        agent.specialty,
        this.specialtyRegistry,
        this.specialtyDefaults,
      );
      if (!defaults) {
        console.error(
          `template reconcile: no known type for specialty "${agent.specialty}" (agent ${agentId}) — leaving it untouched`,
        );
        return emptyResult(agentId, "unknown_specialty");
      }

      const merged = await this.resolve(
        tx,
        agent.accountId,
        agent.specialty,
        specialtyDefaultLayer(defaults),
      );
      const result = emptyResult(agentId, "reconciled");
      // Env goes last: it is the only kind that encrypts on write.
      await this.reconcileTools(tx, agentId, merged, result);
      await this.reconcilePlugins(tx, agentId, merged, result);
      await this.reconcileCrons(tx, agentId, merged, defaults.crons, result);
      await this.reconcileEnv(tx, agentId, merged, result);
      return result;
    });
  }

  /** Loads the in-scope templates and merges them over `base`. */
  private async resolve(
    tx: PrismaTransactionClient,
    accountId: string | null,
    specialty: string,
    base: TemplateLayerInput,
  ): Promise<MergedTemplate> {
    const templates = await tx.agentTemplate.findMany({
      where: {
        AND: [
          {
            OR: [
              { accountId: null },
              ...(accountId === null ? [] : [{ accountId }]),
            ],
          },
          { OR: [{ specialty: null }, { specialty }] },
        ],
      },
      include: { items: true },
    });
    const layers: TemplateLayerInput[] = [base];
    for (const t of templates) {
      layers.push({
        layer: templateLayerForScope(t),
        items: t.items.map((it) => {
          const kind = it.kind as AgentTemplateItemKind;
          return {
            kind,
            key: it.key,
            payload: openTemplateItemPayload(
              kind,
              (it.payload ?? {}) as TemplateItemPayload,
              this.crypto,
            ),
          };
        }),
      });
    }
    return mergeTemplateLayers(layers);
  }

  private async reconcileTools(
    tx: PrismaTransactionClient,
    agentId: string,
    merged: MergedTemplate,
    result: TemplateReconcileResult,
  ): Promise<void> {
    const counts = result.counts.tool;
    const rows = await tx.agentTool.findMany({ where: { agentId } });
    const byPattern = new Map(rows.map((r) => [r.pattern, r]));

    const creates: { pattern: string; enabled: boolean }[] = [];
    const updates: { row: AgentTool; enabled: boolean }[] = [];
    const adopts: AgentTool[] = [];
    for (const item of merged.tool.values()) {
      const enabled = enabledOf(item.payload);
      const row = byPattern.get(item.key);
      if (!row) creates.push({ pattern: item.key, enabled });
      else if (row.source === "template") {
        if (row.enabled !== enabled) updates.push({ row, enabled });
      } else if (row.enabled && enabled) adopts.push(row);
    }
    const orphans = rows.filter(
      (r) => r.source === "template" && !merged.tool.has(r.pattern),
    );

    // Never leave the agent with zero enabled tools.
    const finalEnabled = new Map(rows.map((r) => [r.pattern, r.enabled]));
    for (const c of creates) finalEnabled.set(c.pattern, c.enabled);
    for (const u of updates) finalEnabled.set(u.row.pattern, u.enabled);
    for (const o of orphans) finalEnabled.delete(o.pattern);
    const anyEnabled = [...finalEnabled.values()].some(Boolean);
    const reducing =
      orphans.length > 0 ||
      updates.some((u) => !u.enabled) ||
      creates.some((c) => !c.enabled);
    const guard = !anyEnabled && reducing;
    result.toolsEmptyGuarded = guard;

    for (const c of creates) {
      if (guard && !c.enabled) continue;
      await tx.agentTool.create({
        data: { agentId, ...c, source: "template" },
      });
      counts.created++;
    }
    for (const u of updates) {
      if (guard && !u.enabled) continue;
      await tx.agentTool.update({
        where: { id: u.row.id },
        data: { enabled: u.enabled },
      });
      counts.updated++;
    }
    for (const row of adopts) {
      await tx.agentTool.update({
        where: { id: row.id },
        data: { source: "template" },
      });
      counts.adopted++;
    }
    if (!guard) {
      for (const row of orphans) {
        await tx.agentTool.delete({ where: { id: row.id } });
        counts.deleted++;
      }
    }
  }

  private async reconcilePlugins(
    tx: PrismaTransactionClient,
    agentId: string,
    merged: MergedTemplate,
    result: TemplateReconcileResult,
  ): Promise<void> {
    const counts = result.counts.plugin;
    const rows = await tx.agentPlugin.findMany({ where: { agentId } });
    const byName = new Map<string, AgentPlugin>(rows.map((r) => [r.name, r]));

    for (const item of merged.plugin.values()) {
      const version = versionOf(item.payload);
      const enabled = enabledOf(item.payload);
      const row = byName.get(item.key);
      if (!row) {
        await tx.agentPlugin.create({
          data: {
            agentId,
            name: item.key,
            version,
            enabled,
            source: "template",
          },
        });
        counts.created++;
      } else if (row.source === "template") {
        if (row.version !== version || row.enabled !== enabled) {
          await tx.agentPlugin.update({
            where: { id: row.id },
            data: { version, enabled },
          });
          counts.updated++;
        }
      } else if (row.enabled && enabled && row.version === version) {
        await tx.agentPlugin.update({
          where: { id: row.id },
          data: { source: "template" },
        });
        counts.adopted++;
      }
    }
    for (const row of rows) {
      if (row.source === "template" && !merged.plugin.has(row.name)) {
        await tx.agentPlugin.delete({ where: { id: row.id } });
        counts.deleted++;
      }
    }
  }

  private async reconcileCrons(
    tx: PrismaTransactionClient,
    agentId: string,
    merged: MergedTemplate,
    systemDefaults: readonly SpecialtyDefaultCron[],
    result: TemplateReconcileResult,
  ): Promise<void> {
    // System crons: the specialty's defaults, with a template override of the
    // same name applied to the default's fields.
    const systemNames = new Set(systemDefaults.map((c) => c.name));
    const systemCrons = systemDefaults.map((def): SpecialtyDefaultCron => {
      const winner = merged.cron.get(def.name);
      if (!winner || winner.layer === "specialty-default") return def;
      const f = cronFieldsOf(winner.payload);
      return {
        name: def.name,
        schedule: f.schedule ?? def.schedule,
        prompt: f.prompt ?? def.prompt,
        silent: f.silent ?? def.silent,
        preCheck: f.preCheck ?? def.preCheck,
        enabled: f.enabled ?? def.enabled,
        parentCron: def.parentCron,
      };
    });
    const existingSystem = await tx.agentCronJob.findMany({
      where: { agentId, system: true },
    });
    result.systemCrons = await applySystemCronDefaults(
      tx,
      agentId,
      systemCrons,
      existingSystem,
    );

    // Template crons: every other merged cron, keyed by name.
    const counts = result.counts.cron;
    const rows = await tx.agentCronJob.findMany({
      where: { agentId, system: false },
      orderBy: { createdAt: "asc" },
    });
    const wanted = new Map<string, MergedTemplateItem>();
    for (const item of merged.cron.values()) {
      if (!systemNames.has(item.key)) wanted.set(item.key, item);
    }

    for (const item of wanted.values()) {
      const fields = cronFieldsOf(item.payload);
      if (
        fields.schedule === undefined ||
        fields.prompt === undefined ||
        !isValidCron(fields.schedule)
      ) {
        result.conflicts.push({
          kind: "cron",
          key: item.key,
          reason: "invalid_cron_schedule",
        });
        continue;
      }
      const named = rows.filter((r) => r.name === item.key);
      const owned = named.find((r) => r.source === "template");
      if (owned) {
        const diff = cronDiff(owned, fields);
        if (Object.keys(diff).length > 0) {
          await tx.agentCronJob.update({ where: { id: owned.id }, data: diff });
          counts.updated++;
        }
        continue;
      }
      if (named.length === 0) {
        await tx.agentCronJob.create({
          data: {
            agentId,
            name: item.key,
            system: false,
            source: "template",
            schedule: fields.schedule,
            prompt: fields.prompt,
            channel: fields.channel ?? null,
            user: fields.user ?? null,
            silent: fields.silent ?? false,
            preCheck: fields.preCheck ?? null,
            enabled: fields.enabled ?? true,
          },
        });
        counts.created++;
        continue;
      }
      // A disabled same-named cron is a tombstone or a user decision.
      if (named.some((r) => !r.enabled)) continue;
      const [only] = named;
      if (
        named.length === 1 &&
        only &&
        only.schedule === fields.schedule &&
        only.prompt === fields.prompt
      ) {
        await tx.agentCronJob.update({
          where: { id: only.id },
          data: { ...cronDiff(only, fields), source: "template" },
        });
        counts.adopted++;
        continue;
      }
      result.conflicts.push({
        kind: "cron",
        key: item.key,
        reason: "cron_name_conflict",
      });
    }

    for (const row of rows) {
      if (
        row.source === "template" &&
        (row.name === null || !wanted.has(row.name))
      ) {
        await tx.agentCronJob.delete({ where: { id: row.id } });
        counts.deleted++;
      }
    }
  }

  private async reconcileEnv(
    tx: PrismaTransactionClient,
    agentId: string,
    merged: MergedTemplate,
    result: TemplateReconcileResult,
  ): Promise<void> {
    const counts = result.counts.env;
    const rows = await tx.agentEnv.findMany({ where: { agentId } });
    const byKey = new Map<string, AgentEnv>(rows.map((r) => [r.key, r]));
    const applied = new Set<string>();

    for (const item of merged.env.values()) {
      if (TEMPLATE_ENV_DENYLIST.has(item.key.toUpperCase())) {
        result.conflicts.push({
          kind: "env",
          key: item.key,
          reason: "denylisted_env_key",
        });
        continue;
      }
      applied.add(item.key);
      const value =
        typeof item.payload.value === "string" ? item.payload.value : "";
      const secret = item.payload.secret === true;
      const row = byKey.get(item.key);
      if (!row) {
        await tx.agentEnv.create({
          data: {
            agentId,
            key: item.key,
            value: this.crypto.encrypt(value),
            secret,
            source: "template",
          },
        });
        counts.created++;
      } else if (row.source === "template") {
        if (
          !row.enabled ||
          row.secret !== secret ||
          this.tryDecrypt(row.value) !== value
        ) {
          await tx.agentEnv.update({
            where: { id: row.id },
            data: { value: this.crypto.encrypt(value), secret, enabled: true },
          });
          counts.updated++;
        }
      } else if (row.enabled && this.tryDecrypt(row.value) === value) {
        await tx.agentEnv.update({
          where: { id: row.id },
          data: { source: "template", secret },
        });
        counts.adopted++;
      }
    }
    for (const row of rows) {
      if (row.source === "template" && !applied.has(row.key)) {
        await tx.agentEnv.delete({ where: { id: row.id } });
        counts.deleted++;
      }
    }
  }

  /** Decrypted value, or undefined when the stored value does not decrypt. */
  private tryDecrypt(stored: string): string | undefined {
    try {
      return this.crypto.decrypt(stored);
    } catch {
      return undefined;
    }
  }
}
