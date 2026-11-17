/**
 * admin/src/template-seed.ts
 * TMK-3.2: seed the deployment-wide, all-specialties agent template from
 * SHIPWRIGHT_TEMPLATE_SEED, the JSON the agent-platform chart renders from
 * `admin.templateSeed` Helm values:
 *
 *   {"marketplaces":[{"name":"example-plugins","source":"example-org/plugins","ref":"v1.2.0"}],
 *    "plugins":["some-plugin@example-plugins"]}
 *
 * Only marketplaces and plugins can be seeded. Run once per admin boot, after
 * migrations (admin-boot.ts):
 *
 * - Unset or blank: nothing happens; previously seeded items stay.
 * - A listed kind (`marketplaces` / `plugins` present, even as `[]`) is
 *   replaced: its seeded items become exactly the list. A kind whose key is
 *   absent keeps its seeded items, so removal only ever happens by listing a
 *   smaller seed.
 * - Invalid JSON or an entry failing the template validators (the same
 *   normalizeTemplateItem() as the /templates API): one error naming the
 *   entry is logged and nothing is written.
 *
 * The apply goes through AgentTemplateService.applyManagedItems(): items get
 * managedBy="helm", hand-added items (managedBy null) are never touched, the
 * write holds a transaction-scoped advisory lock so concurrent replicas are
 * safe, and the ATP-2.2 fan-out then reconciles every attached agent.
 *
 * Seeded items are not read-only: UI/API edits are allowed and overwritten on
 * the next boot. Never throws (like startup-policy-reconcile.ts).
 */

import type { AgentTemplateItemKind } from "./agent-template-items.ts";
import {
  type AgentTemplateService,
  type ManagedItemsResult,
  normalizeTemplateItem,
  type TemplateItemInput,
} from "./agent-templates.ts";

export const TEMPLATE_SEED_ENV = "SHIPWRIGHT_TEMPLATE_SEED";

/** AgentTemplateItem.managedBy for seeded items. */
export const TEMPLATE_SEED_MANAGER = "helm";

type SeedKind = Extract<AgentTemplateItemKind, "marketplace" | "plugin">;

export interface TemplateSeed {
  /** The kinds the seed lists; their seeded items are replaced. */
  kinds: SeedKind[];
  items: TemplateItemInput[];
}

export type TemplateSeedParse =
  | { status: "unset" }
  | { status: "ok"; seed: TemplateSeed }
  | { status: "invalid"; error: string };

const MARKETPLACE_FIELDS = new Set(["name", "source", "ref"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

class SeedError extends Error {}

/** `marketplaces[1] (broken)` — how errors name an entry. */
function entryLabel(list: string, index: number, name: unknown): string {
  return typeof name === "string" && name.trim() !== ""
    ? `${list}[${index}] (${name})`
    : `${list}[${index}]`;
}

/** Runs the template validators on one item, naming the entry on failure. */
function validated(label: string, item: TemplateItemInput): TemplateItemInput {
  try {
    const { kind, key, payload } = normalizeTemplateItem(item);
    return { kind, key, payload };
  } catch (err) {
    throw new SeedError(
      `${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseMarketplaces(value: unknown): TemplateItemInput[] {
  if (!Array.isArray(value)) {
    throw new SeedError("marketplaces must be a list");
  }
  const names = new Set<string>();
  return value.map((entry, i) => {
    const name = isObject(entry) ? entry.name : undefined;
    const label = entryLabel("marketplaces", i, name);
    if (!isObject(entry)) {
      throw new SeedError(`${label}: must be an object {name, source, ref?}`);
    }
    const unknown = Object.keys(entry).filter(
      (k) => !MARKETPLACE_FIELDS.has(k),
    );
    if (unknown.length > 0) {
      throw new SeedError(`${label}: unknown field ${unknown.join(", ")}`);
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new SeedError(`${label}: name must be a non-empty string`);
    }
    if (typeof entry.source !== "string" || entry.source.trim() === "") {
      throw new SeedError(`${label}: source must be a non-empty string`);
    }
    const payload: Record<string, unknown> = { source: entry.source };
    if (entry.ref !== undefined) payload.ref = entry.ref;
    const item = validated(label, { kind: "marketplace", key: name, payload });
    if (names.has(item.key)) {
      throw new SeedError(`${label}: duplicate marketplace ${item.key}`);
    }
    names.add(item.key);
    return item;
  });
}

function parsePlugins(value: unknown): TemplateItemInput[] {
  if (!Array.isArray(value)) throw new SeedError("plugins must be a list");
  const specs = new Set<string>();
  return value.map((entry, i) => {
    const label = entryLabel("plugins", i, entry);
    if (typeof entry !== "string") {
      throw new SeedError(`${label}: must be a plugin spec string`);
    }
    const item = validated(label, { kind: "plugin", key: entry, payload: {} });
    if (specs.has(item.key)) {
      throw new SeedError(`${label}: duplicate plugin ${item.key}`);
    }
    specs.add(item.key);
    return item;
  });
}

/** Parses and validates SHIPWRIGHT_TEMPLATE_SEED. Pure; never throws. */
export function parseTemplateSeed(raw: string | undefined): TemplateSeedParse {
  if (raw === undefined || raw.trim() === "") return { status: "unset" };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return {
      status: "invalid",
      error: `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  try {
    if (!isObject(doc)) {
      throw new SeedError(
        "must be a JSON object with marketplaces and/or plugins",
      );
    }
    const unknown = Object.keys(doc).filter(
      (k) => k !== "marketplaces" && k !== "plugins",
    );
    if (unknown.length > 0) {
      throw new SeedError(
        `unknown key ${unknown.join(", ")}; only marketplaces and plugins can be seeded`,
      );
    }
    const kinds: SeedKind[] = [];
    const items: TemplateItemInput[] = [];
    if (doc.marketplaces !== undefined) {
      kinds.push("marketplace");
      items.push(...parseMarketplaces(doc.marketplaces));
    }
    if (doc.plugins !== undefined) {
      kinds.push("plugin");
      items.push(...parsePlugins(doc.plugins));
    }
    return { status: "ok", seed: { kinds, items } };
  } catch (err) {
    if (err instanceof SeedError) {
      return { status: "invalid", error: err.message };
    }
    throw err;
  }
}

export interface TemplateSeedDeps {
  /** The raw env value (process.env.SHIPWRIGHT_TEMPLATE_SEED). */
  raw: string | undefined;
  templateService: Pick<AgentTemplateService, "applyManagedItems">;
  logger: Pick<Console, "log" | "error">;
}

export type TemplateSeedOutcome =
  | { status: "unset" }
  | { status: "invalid"; error: string }
  | { status: "applied"; result: ManagedItemsResult }
  | { status: "failed"; error: string };

/** Applies the seed on boot. Never throws; every failure is logged once. */
export async function runTemplateSeed({
  raw,
  templateService,
  logger,
}: TemplateSeedDeps): Promise<TemplateSeedOutcome> {
  const parsed = parseTemplateSeed(raw);
  if (parsed.status === "unset") return parsed;
  if (parsed.status === "invalid") {
    logger.error(
      `[template-seed] invalid ${TEMPLATE_SEED_ENV}, nothing applied (previously seeded items kept): ${parsed.error}`,
    );
    return parsed;
  }
  try {
    const result = await templateService.applyManagedItems(
      TEMPLATE_SEED_MANAGER,
      parsed.seed.kinds,
      parsed.seed.items,
    );
    const skipped = result.skipped.map((s) => `${s.kind}:${s.key}`).join(",");
    logger.log(
      `[template-seed] kinds=${parsed.seed.kinds.join(",") || "none"} created=${result.created} updated=${result.updated} unchanged=${result.unchanged} deleted=${result.deleted}${skipped ? ` skipped(hand-added)=${skipped}` : ""}`,
    );
    return { status: "applied", result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`[template-seed] apply failed, nothing applied: ${error}`);
    return { status: "failed", error };
  }
}
