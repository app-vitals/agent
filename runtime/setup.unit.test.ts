/**
 * Unit tests for agent/src/runtime/setup.ts — installPlugins local marketplace seam
 *
 * Pure logic tests: no I/O, no real binaries, injected exec doubles only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverBakedMarketplaces,
  installPlugins,
  resolveShipwrightRepoRoot,
  resolveTemplatesDir,
} from "./setup.ts";

// Explicit empty extra-marketplace list — every call in this describe block
// must pass this (or an intentional array) instead of omitting the arg.
// Omitting it falls through to discoverBakedMarketplaces(BAKED_MARKETPLACES_ROOT),
// which reads the REAL /opt/shipwright/marketplaces directory on disk and makes
// these tests depend on ambient sandbox/image state.
const NO_EXTRA_MARKETPLACES: string[] = [];

const SHIPWRIGHT_ROW = { plugin: "shipwright", marketplace: "shipwright" };

// A repo root that carries a local marketplace (a coding image); the platform
// image has none.
const makeMarketplaceRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "mkt-root-"));
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), "{}");
  return root;
};

const recordCalls = () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = async (cmd: string, args: string[], _opts: { cwd: string }) => {
    calls.push({ cmd, args });
    return { stdout: "", exitCode: 0 };
  };
  return { calls, exec };
};

describe("installPlugins — local marketplace", () => {
  let root: string;
  beforeEach(() => {
    root = makeMarketplaceRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (
    exec: ReturnType<typeof recordCalls>["exec"],
    plugins: Array<{ plugin: string; marketplace: string }>,
    repoRoot = root,
    extra: string[] = NO_EXTRA_MARKETPLACES,
  ) =>
    installPlugins(
      exec,
      "/tmp/cwd",
      plugins,
      repoRoot,
      "/tmp/nonexistent-manifest.json",
      extra,
    );

  it("registers the marketplace before installing plugins", async () => {
    const { calls, exec } = recordCalls();
    await run(exec, [SHIPWRIGHT_ROW]);
    expect(calls[0].args).toEqual(["plugin", "marketplace", "add", root]);
  });

  it("installs nothing when the agent has no plugin rows", async () => {
    const { calls, exec } = recordCalls();
    await run(exec, []);
    expect(calls.filter((c) => c.args[1] === "install")).toEqual([]);
    expect(calls.filter((c) => c.args[1] === "update")).toEqual([]);
  });

  it("installs and updates shipwright@shipwright for a coding agent's shipwright row", async () => {
    const { calls, exec } = recordCalls();
    await run(exec, [SHIPWRIGHT_ROW]);
    // marketplace add + install + update = 3 calls
    expect(calls).toHaveLength(3);
    expect(calls[1].args).toEqual([
      "plugin",
      "install",
      "shipwright@shipwright",
    ]);
    expect(calls[2].args).toEqual([
      "plugin",
      "update",
      "shipwright@shipwright",
    ]);
  });

  it("agent plugins use their own marketplace, not the local one", async () => {
    const { calls, exec } = recordCalls();
    await run(exec, [
      SHIPWRIGHT_ROW,
      { plugin: "my-plugin", marketplace: "org/my-marketplace" },
    ]);
    // marketplace add + 2 installs + 2 updates = 5 calls
    expect(calls).toHaveLength(5);
    expect(calls.slice(1).map((c) => c.args[2])).toEqual([
      "shipwright@shipwright",
      "my-plugin@org/my-marketplace",
      "shipwright@shipwright",
      "my-plugin@org/my-marketplace",
    ]);
  });

  it("skips the local marketplace add when the repo root has no marketplace", async () => {
    const { calls, exec } = recordCalls();
    await run(exec, [], "/repo/root");
    expect(calls).toEqual([]);
  });

  it("registers extra marketplaces before the local marketplace", async () => {
    const { calls, exec } = recordCalls();
    await run(exec, [], root, ["/opt/shipwright/marketplaces/my-marketplace"]);
    const addCalls = calls.filter((c) => c.args[1] === "marketplace");
    expect(addCalls[0].args[3]).toBe(
      "/opt/shipwright/marketplaces/my-marketplace",
    );
    expect(addCalls[1].args[3]).toBe(root);
  });

  it("never reads the real BAKED_MARKETPLACES_ROOT when extraMarketplaceDirs is injected (isolation regression)", async () => {
    // The injected empty array must win over real fs discovery of
    // /opt/shipwright/marketplaces, whatever the sandbox has baked there.
    const { calls, exec } = recordCalls();
    await run(exec, [SHIPWRIGHT_ROW]);
    const addCalls = calls.filter((c) => c.args[1] === "marketplace");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].args[3]).toBe(root);
    expect(calls).toHaveLength(3);
  });
});

describe("discoverBakedMarketplaces", () => {
  it("returns dirs that have .claude-plugin/marketplace.json", () => {
    // Since discoverBakedMarketplaces uses real fs, we test with a known-absent path
    // The actual fs-based tests live in setup.integration.test.ts.
    // This unit test verifies the function is exported and handles absent roots.
    const result = discoverBakedMarketplaces(
      "/tmp/nonexistent-convention-root-abc123",
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when conventionRoot is absent (empty string)", () => {
    const result = discoverBakedMarketplaces("");
    expect(result).toEqual([]);
  });

  it("returns empty array when conventionRoot does not exist", () => {
    const result = discoverBakedMarketplaces("/opt/does-not-exist-xyz987");
    expect(result).toEqual([]);
  });
});

describe("resolveTemplatesDir option resolution (AEP-1.2)", () => {
  it("resolves the shipped specialist manifest to agent-types/specialist/templates/ with no warning (SAI-1.2)", async () => {
    const { resolveTemplatesDir } = await import("./setup.ts");
    const repoRoot = join(import.meta.dir, "..");
    const warnings: string[] = [];
    const dir = resolveTemplatesDir(
      "specialist",
      repoRoot,
      (m) => warnings.push(m),
      { SHIPWRIGHT_SPECIALTIES_DIR: join(repoRoot, "agent-types") },
    );
    expect(dir).toBe(join(repoRoot, "agent-types", "specialist", "templates"));
    expect(warnings).toEqual([]);
  });

  it("resolves an absent type as the shipped specialist type with no env and no warning", async () => {
    const { resolveTemplatesDir } = await import("./setup.ts");
    const warnings: string[] = [];
    const dir = resolveTemplatesDir(
      undefined,
      join(import.meta.dir, ".."),
      (m) => warnings.push(m),
      {},
    );
    expect(warnings).toEqual([]);
    expect(dir).toBe(
      join(import.meta.dir, "..", "agent-types", "specialist", "templates"),
    );
  });

  it("warns and falls back to the default type's templates for an unknown requested type", async () => {
    const { resolveTemplatesDir } = await import("./setup.ts");
    const warnings: string[] = [];
    const dir = resolveTemplatesDir(
      "renamed-type",
      join(import.meta.dir, ".."),
      (m) => warnings.push(m),
      {},
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"renamed-type"');
    expect(warnings[0]).toContain('"specialist"');
    expect(dir).toBe(
      join(import.meta.dir, "..", "agent-types", "specialist", "templates"),
    );
  });

  it("falls back to the built-in templates when the default type cannot load either", async () => {
    const { resolveTemplatesDir } = await import("./setup.ts");
    const warnings: string[] = [];
    const dir = resolveTemplatesDir(
      "renamed-type",
      "/nonexistent",
      (m) => warnings.push(m),
      { SHIPWRIGHT_SPECIALTIES_DIR: "/nonexistent/types" },
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("built-in");
    expect(dir).toMatch(/workspace$/);
  });

  it("looks up SHIPWRIGHT_DEFAULT_AGENT_TYPE under SHIPWRIGHT_SPECIALTIES_DIR for an absent type", async () => {
    const { resolveTemplatesDir } = await import("./setup.ts");
    const warnings: string[] = [];
    const dir = resolveTemplatesDir(
      undefined,
      "/nonexistent",
      (m) => warnings.push(m),
      {
        SHIPWRIGHT_DEFAULT_AGENT_TYPE: "base",
        SHIPWRIGHT_SPECIALTIES_DIR: "/fixture/types",
      },
    );
    // Missing fixture manifest → warns naming the type, falls back built-in.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"base"');
    expect(warnings[0]).toContain("/fixture/types/base/manifest.yaml");
    expect(dir).toMatch(/workspace$/);
  });
});

describe("SHIPWRIGHT_REPO_ROOT override (PCB-1.1)", () => {
  const recordExec = () => {
    const calls: string[][] = [];
    const exec = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { stdout: "", exitCode: 0 };
    };
    return { calls, exec };
  };
  const registerRoot = async (env: Record<string, string | undefined>) => {
    const { calls, exec } = recordExec();
    await installPlugins(
      exec,
      "/tmp/cwd",
      [],
      undefined,
      "/tmp/nonexistent-manifest.json",
      NO_EXTRA_MARKETPLACES,
      "/tmp/nonexistent-baked-root",
      env,
    );
    return calls[0]?.[3];
  };

  it("installPlugins registers the marketplace from SHIPWRIGHT_REPO_ROOT when set", async () => {
    const custom = makeMarketplaceRoot();
    try {
      expect(await registerRoot({ SHIPWRIGHT_REPO_ROOT: custom })).toBe(custom);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("installPlugins keeps the computed default when unset or empty", async () => {
    const unset = await registerRoot({});
    // Only registered when the computed default root carries a marketplace.
    expect(unset === undefined || unset === resolveShipwrightRepoRoot({})).toBe(
      true,
    );
    expect(await registerRoot({ SHIPWRIGHT_REPO_ROOT: "" })).toBe(unset);
  });

  describe("resolveTemplatesDir", () => {
    const makeRoot = () => {
      const root = mkdtempSync(join(tmpdir(), "repo-root-"));
      const dir = join(root, "types", "foo");
      mkdirSync(join(dir, "tpl"), { recursive: true });
      writeFileSync(
        join(dir, "manifest.yaml"),
        "identity:\n  templatesDir: tpl\n",
      );
      for (const f of [
        "CLAUDE.md.template",
        "SOUL.md.template",
        "IDENTITY.md.template",
      ]) {
        writeFileSync(join(dir, "tpl", f), "x");
      }
      return { root, tpl: join(dir, "tpl") };
    };

    it("resolves templatesDir against SHIPWRIGHT_REPO_ROOT when set", () => {
      const { root, tpl } = makeRoot();
      try {
        const warnings: string[] = [];
        const dir = resolveTemplatesDir(
          "foo",
          undefined,
          (m) => warnings.push(m),
          {
            SHIPWRIGHT_REPO_ROOT: root,
            SHIPWRIGHT_SPECIALTIES_DIR: join(root, "types"),
          },
        );
        expect(warnings).toEqual([]);
        expect(dir).toBe(tpl);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("does not use the override when unset or empty", () => {
      const { root, tpl } = makeRoot();
      try {
        for (const env of [{}, { SHIPWRIGHT_REPO_ROOT: "" }]) {
          const warnings: string[] = [];
          const dir = resolveTemplatesDir(
            "foo",
            undefined,
            (m) => warnings.push(m),
            env,
          );
          expect(dir).not.toBe(tpl);
          expect(warnings).toHaveLength(1);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
