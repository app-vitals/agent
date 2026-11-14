/**
 * admin/src/agent-template-merge.ts
 * ATP-2.1: resolves the effective template for one agent by merging the
 * template layers by (kind, key), ascending specificity:
 *
 *   0. specialty-default    built-in specialty defaults (extension hook or
 *                           the built-in type, plus the platform plugins)
 *   1. deployment           AgentTemplate(accountId null, specialty null)
 *   2. deployment-specialty AgentTemplate(accountId null, specialty = agent's)
 *   3. account              AgentTemplate(accountId = agent's, specialty null)
 *   4. account-specialty    AgentTemplate(accountId = agent's, specialty = agent's)
 *
 * A more specific layer replaces the whole payload of a key defined lower
 * down. Pure: no DB, no crypto; the reconcile (agent-template-reconcile.ts)
 * loads the layers and applies the result.
 */

import { resolveDefaultPlugins } from "@app-vitals/agent-lib/default-plugins";
import type { AgentTemplateItemKind } from "./agent-template-items.ts";
import type {
  SpecialtyDefaultCron,
  SpecialtyDefaultsResolver,
} from "./specialty-defaults.ts";
import type { SpecialtyTypeResolver } from "./specialty-types.ts";

export const TEMPLATE_LAYERS = [
  "specialty-default",
  "deployment",
  "deployment-specialty",
  "account",
  "account-specialty",
] as const;
export type TemplateLayer = (typeof TEMPLATE_LAYERS)[number];

export interface TemplateLayerItem {
  kind: AgentTemplateItemKind;
  key: string;
  payload: Record<string, unknown>;
}

export interface TemplateLayerInput {
  layer: TemplateLayer;
  items: readonly TemplateLayerItem[];
}

/** One resolved item and the layer it came from. */
export interface MergedTemplateItem extends TemplateLayerItem {
  layer: TemplateLayer;
}

/** The resolved template: per kind, key → winning item (first-seen order). */
export type MergedTemplate = Record<
  AgentTemplateItemKind,
  Map<string, MergedTemplateItem>
>;

/** The layer an AgentTemplate row's scope sits in. */
export function templateLayerForScope(scope: {
  accountId: string | null;
  specialty: string | null;
}): Exclude<TemplateLayer, "specialty-default"> {
  if (scope.accountId === null) {
    return scope.specialty === null ? "deployment" : "deployment-specialty";
  }
  return scope.specialty === null ? "account" : "account-specialty";
}

/** Merge layers by (kind, key); the most specific layer wins. */
export function mergeTemplateLayers(
  layers: readonly TemplateLayerInput[],
): MergedTemplate {
  const merged: MergedTemplate = {
    env: new Map(),
    tool: new Map(),
    plugin: new Map(),
    cron: new Map(),
  };
  const ordered = [...layers].sort(
    (a, b) =>
      TEMPLATE_LAYERS.indexOf(a.layer) - TEMPLATE_LAYERS.indexOf(b.layer),
  );
  for (const { layer, items } of ordered) {
    for (const item of items) {
      merged[item.kind].set(item.key, {
        kind: item.kind,
        key: item.key,
        payload: item.payload,
        layer,
      });
    }
  }
  return merged;
}

/** The built-in defaults of one specialty. */
export interface SpecialtyDefaultSet {
  tools: readonly string[];
  plugins: readonly string[];
  crons: readonly SpecialtyDefaultCron[];
}

/**
 * The specialty's built-in defaults, resolved the same way createAgent() and
 * reconcileSystemCrons() do: extension-supplied values first, else the
 * built-in type (no fallback to another type). Undefined when the specialty
 * is neither.
 */
export function resolveSpecialtyDefaultSet(
  specialty: string,
  registry: Pick<SpecialtyTypeResolver, "tryGetType">,
  specialtyDefaults?: SpecialtyDefaultsResolver,
): SpecialtyDefaultSet | undefined {
  const extension = specialtyDefaults?.(specialty);
  const type = registry.tryGetType(specialty);
  if (!extension && !type) return undefined;
  return {
    tools: extension?.tools ?? type?.tools ?? [],
    plugins: resolveDefaultPlugins(extension?.plugins),
    crons: extension?.crons ?? [],
  };
}

/** Layer 0: the specialty defaults as template items. */
export function specialtyDefaultLayer(
  defaults: SpecialtyDefaultSet,
): TemplateLayerInput {
  const items: TemplateLayerItem[] = [
    ...defaults.tools.map(
      (key): TemplateLayerItem => ({ kind: "tool", key, payload: {} }),
    ),
    ...defaults.plugins.map(
      (key): TemplateLayerItem => ({
        kind: "plugin",
        key,
        payload: { version: null },
      }),
    ),
    ...defaults.crons.map((c): TemplateLayerItem => {
      const payload: Record<string, unknown> = {
        schedule: c.schedule,
        prompt: c.prompt,
      };
      if (c.silent !== undefined) payload.silent = c.silent;
      if (c.preCheck !== undefined) payload.preCheck = c.preCheck;
      if (c.enabled !== undefined) payload.enabled = c.enabled;
      return { kind: "cron", key: c.name, payload };
    }),
  ];
  return { layer: "specialty-default", items };
}
