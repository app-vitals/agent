/**
 * admin/src/agent-template-merge.unit.test.ts
 * ATP-2.1: the pure five-layer template merge.
 */

import { describe, expect, it } from "bun:test";
import { AGENT_PLATFORM_PLUGIN } from "@app-vitals/agent-lib/default-plugins";
import {
  mergeTemplateLayers,
  resolveSpecialtyDefaultSet,
  specialtyDefaultLayer,
  TEMPLATE_LAYERS,
  type TemplateLayerInput,
  templateLayerForScope,
} from "./agent-template-merge.ts";
import { SPECIALIST_TYPE } from "./specialty-types.ts";

const plugin = (version: string | null) => ({
  kind: "plugin" as const,
  key: "p@m",
  payload: { version },
});

describe("templateLayerForScope", () => {
  it("maps each (accountId, specialty) scope to its layer", () => {
    expect(templateLayerForScope({ accountId: null, specialty: null })).toBe(
      "deployment",
    );
    expect(templateLayerForScope({ accountId: null, specialty: "x" })).toBe(
      "deployment-specialty",
    );
    expect(templateLayerForScope({ accountId: "a", specialty: null })).toBe(
      "account",
    );
    expect(templateLayerForScope({ accountId: "a", specialty: "x" })).toBe(
      "account-specialty",
    );
  });
});

describe("mergeTemplateLayers", () => {
  it("lists the layers in ascending specificity", () => {
    expect([...TEMPLATE_LAYERS]).toEqual([
      "specialty-default",
      "deployment",
      "deployment-specialty",
      "account",
      "account-specialty",
    ]);
  });

  it("the most specific layer wins for a key defined in all five, whatever the input order", () => {
    const layers: TemplateLayerInput[] = [
      { layer: "account", items: [plugin("3")] },
      { layer: "account-specialty", items: [plugin("4")] },
      { layer: "deployment", items: [plugin("1")] },
      { layer: "specialty-default", items: [plugin(null)] },
      { layer: "deployment-specialty", items: [plugin("2")] },
    ];
    const merged = mergeTemplateLayers(layers);
    expect(merged.plugin.get("p@m")).toEqual({
      kind: "plugin",
      key: "p@m",
      payload: { version: "4" },
      layer: "account-specialty",
    });
  });

  it("falls through to the next most specific layer that defines the key", () => {
    for (const [drop, expected] of [
      ["account-specialty", "3"],
      ["account", "2"],
      ["deployment-specialty", "1"],
      ["deployment", null],
    ] as const) {
      const all: TemplateLayerInput[] = [
        { layer: "specialty-default", items: [plugin(null)] },
        { layer: "deployment", items: [plugin("1")] },
        { layer: "deployment-specialty", items: [plugin("2")] },
        { layer: "account", items: [plugin("3")] },
        { layer: "account-specialty", items: [plugin("4")] },
      ];
      const order = TEMPLATE_LAYERS.indexOf(drop);
      const kept = all.filter((l) => TEMPLATE_LAYERS.indexOf(l.layer) < order);
      expect(mergeTemplateLayers(kept).plugin.get("p@m")?.payload).toEqual({
        version: expected,
      });
    }
  });

  it("merges by key: distinct keys from every layer are all kept, kinds stay separate", () => {
    const merged = mergeTemplateLayers([
      {
        layer: "specialty-default",
        items: [{ kind: "tool", key: "Bash", payload: {} }],
      },
      {
        layer: "deployment",
        items: [
          { kind: "env", key: "SENTRY_DSN", payload: { value: "x" } },
          { kind: "tool", key: "Read", payload: {} },
        ],
      },
      {
        layer: "account",
        items: [{ kind: "env", key: "Bash", payload: { value: "y" } }],
      },
    ]);
    expect([...merged.tool.keys()]).toEqual(["Bash", "Read"]);
    expect([...merged.env.keys()]).toEqual(["SENTRY_DSN", "Bash"]);
    expect(merged.tool.get("Bash")?.layer).toBe("specialty-default");
    expect(merged.plugin.size).toBe(0);
    expect(merged.cron.size).toBe(0);
  });

  it("an empty input yields an empty template", () => {
    const merged = mergeTemplateLayers([]);
    expect(merged.env.size + merged.tool.size).toBe(0);
    expect(merged.plugin.size + merged.cron.size).toBe(0);
  });
});

describe("specialtyDefaultLayer", () => {
  it("turns specialty defaults into layer-0 items", () => {
    const layer = specialtyDefaultLayer({
      tools: ["Bash"],
      plugins: ["a@b"],
      crons: [
        {
          name: "loop",
          schedule: "* * * * *",
          prompt: "/loop",
          silent: true,
          parentCron: "x",
        },
      ],
    });
    expect(layer.layer).toBe("specialty-default");
    expect(layer.items).toEqual([
      { kind: "tool", key: "Bash", payload: {} },
      { kind: "plugin", key: "a@b", payload: { version: null } },
      {
        kind: "cron",
        key: "loop",
        payload: { schedule: "* * * * *", prompt: "/loop", silent: true },
      },
    ]);
  });
});

describe("resolveSpecialtyDefaultSet", () => {
  const registry = {
    tryGetType: (s: string) =>
      s === SPECIALIST_TYPE.name ? SPECIALIST_TYPE : undefined,
  };

  it("uses the built-in type's tools and the platform plugins for a built-in type", () => {
    expect(resolveSpecialtyDefaultSet("specialist", registry)).toEqual({
      tools: SPECIALIST_TYPE.tools,
      plugins: [AGENT_PLATFORM_PLUGIN],
      crons: [],
    });
  });

  it("prefers extension-supplied defaults", () => {
    const set = resolveSpecialtyDefaultSet("coding", registry, (s) =>
      s === "coding"
        ? {
            tools: ["Read"],
            plugins: ["x@y"],
            crons: [{ name: "c", schedule: "* * * * *", prompt: "p" }],
          }
        : undefined,
    );
    expect(set?.tools).toEqual(["Read"]);
    expect(set?.plugins).toEqual([AGENT_PLATFORM_PLUGIN, "x@y"]);
    expect(set?.crons.map((c) => c.name)).toEqual(["c"]);
  });

  it("returns undefined for a specialty that is neither built in nor extension-supplied", () => {
    expect(resolveSpecialtyDefaultSet("nope", registry)).toBeUndefined();
  });
});

describe("mergeTemplateLayers: marketplace items", () => {
  const mk = (source: string) => ({
    kind: "marketplace" as const,
    key: "example-plugins",
    payload: { source },
  });
  const winner = (layers: TemplateLayerInput[]) =>
    mergeTemplateLayers(layers).marketplace.get("example-plugins");

  it("applies the plugin layer precedence, narrowest layer wins", () => {
    const layers: TemplateLayerInput[] = [
      { layer: "account", items: [mk("o/3")] },
      { layer: "account-specialty", items: [mk("o/4")] },
      { layer: "deployment", items: [mk("o/1")] },
      { layer: "specialty-default", items: [mk("o/0")] },
      { layer: "deployment-specialty", items: [mk("o/2")] },
    ];
    expect(winner(layers)).toEqual({
      kind: "marketplace",
      key: "example-plugins",
      payload: { source: "o/4" },
      layer: "account-specialty",
    });
    const without = (...drop: string[]) =>
      layers.filter((l) => !drop.includes(l.layer));
    expect(winner(without("account-specialty"))?.payload.source).toBe("o/3");
    expect(
      winner(without("account-specialty", "account"))?.payload.source,
    ).toBe("o/2");
    expect(
      winner(without("account-specialty", "account", "deployment-specialty"))
        ?.payload.source,
    ).toBe("o/1");
  });

  it("keeps marketplaces separate from plugins of the same key", () => {
    const merged = mergeTemplateLayers([
      {
        layer: "deployment",
        items: [
          mk("o/1"),
          { kind: "plugin", key: "example-plugins", payload: {} },
        ],
      },
    ]);
    expect(merged.marketplace.size).toBe(1);
    expect(merged.plugin.size).toBe(1);
  });
});
