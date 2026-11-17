/**
 * admin/src/template-seed.unit.test.ts
 * TMK-3.2: SHIPWRIGHT_TEMPLATE_SEED parsing and validation, and the
 * never-throwing boot runner over a stubbed template service. Pure; no DB.
 */

import { describe, expect, it } from "bun:test";
import type { TemplateItemInput } from "./agent-templates.ts";
import {
  parseTemplateSeed,
  runTemplateSeed,
  TEMPLATE_SEED_MANAGER,
} from "./template-seed.ts";

const VALID = JSON.stringify({
  marketplaces: [
    { name: "example-plugins", source: "example-org/plugins", ref: "v1.2.0" },
    { name: "other", source: "https://example.com/other.git" },
  ],
  plugins: ["some-plugin@example-plugins", "tool@other"],
});

function invalid(raw: string): string {
  const parsed = parseTemplateSeed(raw);
  if (parsed.status !== "invalid") {
    throw new Error(`expected invalid, got ${parsed.status}`);
  }
  return parsed.error;
}

describe("parseTemplateSeed", () => {
  it("treats an unset, empty or blank value as unset", () => {
    expect(parseTemplateSeed(undefined)).toEqual({ status: "unset" });
    expect(parseTemplateSeed("")).toEqual({ status: "unset" });
    expect(parseTemplateSeed("   \n")).toEqual({ status: "unset" });
  });

  it("parses marketplaces and plugins into template items", () => {
    const parsed = parseTemplateSeed(VALID);
    expect(parsed).toEqual({
      status: "ok",
      seed: {
        kinds: ["marketplace", "plugin"],
        items: [
          {
            kind: "marketplace",
            key: "example-plugins",
            payload: { source: "example-org/plugins", ref: "v1.2.0" },
          },
          {
            kind: "marketplace",
            key: "other",
            payload: { source: "https://example.com/other.git" },
          },
          { kind: "plugin", key: "some-plugin@example-plugins", payload: {} },
          { kind: "plugin", key: "tool@other", payload: {} },
        ],
      },
    });
  });

  it("lists only the kinds whose key is present, so an absent key leaves that kind alone", () => {
    const parsed = parseTemplateSeed(JSON.stringify({ plugins: ["a@b"] }));
    expect(parsed.status === "ok" && parsed.seed.kinds).toEqual(["plugin"]);
  });

  it("keeps an empty list as a managed kind with no items (clears it)", () => {
    const parsed = parseTemplateSeed(
      JSON.stringify({ marketplaces: [], plugins: [] }),
    );
    expect(parsed).toEqual({
      status: "ok",
      seed: { kinds: ["marketplace", "plugin"], items: [] },
    });
  });

  it("accepts a null ref as no ref", () => {
    const parsed = parseTemplateSeed(
      JSON.stringify({
        marketplaces: [{ name: "mk", source: "org/repo", ref: null }],
      }),
    );
    expect(parsed.status === "ok" && parsed.seed.items[0]?.payload).toEqual({
      source: "org/repo",
      ref: null,
    });
  });

  it("rejects malformed JSON", () => {
    expect(invalid("{not json")).toContain("not valid JSON");
  });

  it("rejects a non-object document", () => {
    expect(invalid("[]")).toContain("must be a JSON object");
    expect(invalid("null")).toContain("must be a JSON object");
  });

  it("rejects kinds that cannot be seeded", () => {
    const error = invalid(JSON.stringify({ env: { A: "1" } }));
    expect(error).toContain("env");
    expect(error).toContain("marketplaces and plugins");
  });

  it("rejects a marketplaces value that is not a list", () => {
    expect(invalid(JSON.stringify({ marketplaces: {} }))).toContain(
      "marketplaces must be a list",
    );
  });

  it("names a marketplace entry missing its source", () => {
    const error = invalid(
      JSON.stringify({
        marketplaces: [
          { name: "fine", source: "org/fine" },
          { name: "broken" },
        ],
      }),
    );
    expect(error).toContain("marketplaces[1]");
    expect(error).toContain("broken");
    expect(error).toContain("source");
  });

  it("names a marketplace entry whose source fails the template validators", () => {
    const error = invalid(
      JSON.stringify({
        marketplaces: [{ name: "bad-src", source: "--upload-pack=evil" }],
      }),
    );
    expect(error).toContain("marketplaces[0]");
    expect(error).toContain("bad-src");
  });

  it("names a marketplace entry with an invalid name", () => {
    const error = invalid(
      JSON.stringify({
        marketplaces: [{ name: "../escape", source: "org/repo" }],
      }),
    );
    expect(error).toContain("marketplaces[0]");
  });

  it("rejects unknown fields on a marketplace entry", () => {
    const error = invalid(
      JSON.stringify({
        marketplaces: [{ name: "mk", source: "org/repo", branch: "main" }],
      }),
    );
    expect(error).toContain("marketplaces[0]");
    expect(error).toContain("branch");
  });

  it("names a plugin entry that is not a string", () => {
    const error = invalid(JSON.stringify({ plugins: ["ok@mk", { name: 1 }] }));
    expect(error).toContain("plugins[1]");
    expect(error).toContain("string");
  });

  it("names an empty plugin entry", () => {
    expect(invalid(JSON.stringify({ plugins: ["  "] }))).toContain(
      "plugins[0]",
    );
  });

  it("rejects duplicate entries", () => {
    expect(
      invalid(
        JSON.stringify({
          marketplaces: [
            { name: "mk", source: "org/a" },
            { name: "mk", source: "org/b" },
          ],
        }),
      ),
    ).toContain("marketplaces[1]");
    expect(invalid(JSON.stringify({ plugins: ["a@b", "a@b"] }))).toContain(
      "plugins[1]",
    );
  });
});

describe("runTemplateSeed", () => {
  function harness(apply?: () => Promise<unknown>) {
    const calls: {
      managedBy: string;
      kinds: readonly string[];
      items: TemplateItemInput[];
    }[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const templateService = {
      async applyManagedItems(
        managedBy: string,
        kinds: readonly ("marketplace" | "plugin")[],
        items: TemplateItemInput[],
      ) {
        calls.push({ managedBy, kinds, items });
        if (apply) await apply();
        return {
          templateId: "t1",
          created: items.length,
          updated: 0,
          unchanged: 0,
          deleted: 0,
          skipped: [],
          fanOut: true,
        };
      },
    };
    const logger = {
      log: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
      error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
    };
    return { calls, logs, errors, templateService, logger };
  }

  it("does nothing when the env var is unset", async () => {
    const h = harness();
    const result = await runTemplateSeed({
      raw: undefined,
      templateService: h.templateService as never,
      logger: h.logger,
    });
    expect(result.status).toBe("unset");
    expect(h.calls).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });

  it("applies a valid seed as helm-managed items", async () => {
    const h = harness();
    const result = await runTemplateSeed({
      raw: VALID,
      templateService: h.templateService as never,
      logger: h.logger,
    });
    expect(result.status).toBe("applied");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.managedBy).toBe(TEMPLATE_SEED_MANAGER);
    expect(TEMPLATE_SEED_MANAGER).toBe("helm");
    expect(h.calls[0]?.kinds).toEqual(["marketplace", "plugin"]);
    expect(h.calls[0]?.items).toHaveLength(4);
    expect(h.logs.join("\n")).toContain("[template-seed]");
  });

  it("logs exactly one error naming the bad entry and applies nothing for an invalid seed", async () => {
    const h = harness();
    const result = await runTemplateSeed({
      raw: JSON.stringify({ marketplaces: [{ name: "nosource" }] }),
      templateService: h.templateService as never,
      logger: h.logger,
    });
    expect(result.status).toBe("invalid");
    expect(h.calls).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("SHIPWRIGHT_TEMPLATE_SEED");
    expect(h.errors[0]).toContain("nosource");
  });

  it("never throws when the apply fails", async () => {
    const h = harness(async () => {
      throw new Error("db down");
    });
    const result = await runTemplateSeed({
      raw: VALID,
      templateService: h.templateService as never,
      logger: h.logger,
    });
    expect(result.status).toBe("failed");
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("db down");
  });
});
