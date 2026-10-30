/**
 * admin/src/specialty-manifest-loader.unit.test.ts
 * Unit tests for SpecialtyRegistry — the disk-backed resolver from an agent's
 * specialty to its parsed manifest, with the unknown-type default-type fallback.
 *
 * Pure logic against an injected reader/warner — no filesystem, no DB. See
 * docs/testing.md for the unit-layer contract.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SPECIALTY_NAME,
  resolveDefaultSpecialtyName,
  resolveSpecialtiesDir,
  SpecialtyRegistry,
} from "./specialty-manifest-loader.ts";

/** A minimal valid Specialty manifest YAML for a given type name. */
function manifestYaml(name: string): string {
  return `apiVersion: shipwright.dev/v1alpha1
kind: Specialty
metadata:
  name: ${name}
  displayName: ${name}
  description: test manifest
  version: 1.0.0
  skills: []
identity:
  templatesDir: workspace/
crons:
  - name: ${name}-cron
    schedule: "* * * * *"
    prompt: /noop
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: true
`;
}

describe("SpecialtyRegistry", () => {
  it("resolves a known specialty to its parsed manifest", () => {
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      read: (t) => manifestYaml(t),
    });
    const manifest = registry.getManifest("specialist");
    expect(manifest.metadata.name).toBe("specialist");
    expect(manifest.crons[0]?.name).toBe("specialist-cron");
  });

  it("falls back to the default (specialist) manifest with a warning for an unknown specialty", () => {
    const warnings: string[] = [];
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      read: (t) => {
        if (t === DEFAULT_SPECIALTY_NAME) return manifestYaml("specialist");
        throw new Error(`ENOENT: no manifest for ${t}`);
      },
      warn: (m) => warnings.push(m),
    });

    const manifest = registry.getManifest("renamed-type");

    expect(manifest.metadata.name).toBe("specialist");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("renamed-type");
    expect(warnings[0]).toContain("specialist");
  });

  it("never throws: an unloadable default degrades to an empty-crons manifest with warnings naming the env knobs", () => {
    const warnings: string[] = [];
    const registry = new SpecialtyRegistry({
      read: () => {
        throw new Error("ENOENT: no manifest");
      },
      warn: (m) => warnings.push(m),
      typesDir: "/nonexistent/specialties",
      defaultTypeName: "absent",
    });

    for (const specialty of ["absent", "some-other-type"]) {
      warnings.length = 0;
      const manifest = registry.getManifest(specialty);
      expect(manifest.crons).toEqual([]);
      expect(manifest.plugins).toEqual([]);
      const all = warnings.join("\n");
      expect(all).toContain('default specialty "absent"');
      expect(all).toContain("/nonexistent/specialties");
      expect(all).toContain("SHIPWRIGHT_SPECIALTIES_DIR");
      expect(all).toContain("SHIPWRIGHT_DEFAULT_AGENT_TYPE");
    }
  });

  it("uses the default manifest silently when the default type itself is requested and loads", () => {
    const warnings: string[] = [];
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      read: (t) => manifestYaml(t),
      warn: (m) => warnings.push(m),
    });
    expect(registry.getManifest(DEFAULT_SPECIALTY_NAME).metadata.name).toBe(
      "specialist",
    );
    expect(warnings).toEqual([]);
  });

  it("caches a resolved manifest — the reader is called once per type", () => {
    let reads = 0;
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      read: (t) => {
        reads++;
        return manifestYaml(t);
      },
    });

    registry.getManifest("specialist");
    registry.getManifest("specialist");

    expect(reads).toBe(1);
  });

  // ─── tryGetManifest — non-fallback lookup ────────────────────────────────
  //
  // Unlike getManifest(), tryGetManifest() must NOT fall back to the default type for
  // an unknown specialty — it returns undefined instead. This is what lets
  // POST /agents distinguish "resolved to the exact requested type" from
  // "silently degraded", which the cron-reconcile boot path (getManifest())
  // deliberately does not need to distinguish.

  it("tryGetManifest resolves a known specialty to its parsed manifest", () => {
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      read: (t) => manifestYaml(t),
    });
    const manifest = registry.tryGetManifest("specialist");
    expect(manifest?.metadata.name).toBe("specialist");
  });

  it("tryGetManifest returns undefined for an unknown specialty — no fallback, no warning", () => {
    const warnings: string[] = [];
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      read: (t) => {
        if (t === DEFAULT_SPECIALTY_NAME) return manifestYaml("specialist");
        throw new Error(`ENOENT: no manifest for ${t}`);
      },
      warn: (m) => warnings.push(m),
    });

    const manifest = registry.tryGetManifest("nonexistent-type");

    expect(manifest).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("tryGetManifest shares the cache with getManifest — reader called once per type", () => {
    let reads = 0;
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      read: (t) => {
        reads++;
        return manifestYaml(t);
      },
    });

    registry.getManifest("specialist");
    registry.tryGetManifest("specialist");

    expect(reads).toBe(1);
  });

  // ─── listTypes — populates the new-specialty picker ─────────────────────
  //
  // Discovers every directory under specialties/ via the injected `list` fn,
  // then resolves each one's manifest via the existing `read` path — so
  // listTypes() shares the same disk-free-in-tests DI contract as
  // getManifest()/tryGetManifest().

  it("listTypes lists every discovered type as {name, displayName}", () => {
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      list: () => ["coding"],
      read: (t) => manifestYaml(t),
    });

    const types = registry.listTypes();

    expect(types).toEqual([{ name: "coding", displayName: "coding" }]);
  });

  it("listTypes resolves displayName from each manifest's metadata.displayName", () => {
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      list: () => ["coding"],
      read: () => `apiVersion: shipwright.dev/v1alpha1
kind: Specialty
metadata:
  name: coding
  displayName: Coding Agent
  description: test manifest
  version: 1.0.0
  skills: []
identity:
  templatesDir: workspace/
crons: []
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: true
`,
    });

    const types = registry.listTypes();

    expect(types).toEqual([{ name: "coding", displayName: "Coding Agent" }]);
  });

  it("listTypes lists multiple discovered types", () => {
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      list: () => ["coding", "research"],
      read: (t) => manifestYaml(t),
    });

    const types = registry.listTypes();

    expect(types).toEqual([
      { name: "coding", displayName: "coding" },
      { name: "research", displayName: "research" },
    ]);
  });

  it("listTypes skips a directory whose manifest fails to load or parse", () => {
    const warnings: string[] = [];
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      list: () => ["coding", "broken"],
      read: (t) => {
        if (t === "broken") throw new Error("ENOENT: broken manifest");
        return manifestYaml(t);
      },
      warn: (m) => warnings.push(m),
    });

    const types = registry.listTypes();

    expect(types).toEqual([{ name: "coding", displayName: "coding" }]);
  });

  it("listTypes returns an empty array when no type directories are discovered", () => {
    const registry = new SpecialtyRegistry({
      defaultTypeName: DEFAULT_SPECIALTY_NAME,
      list: () => [],
      read: (t) => manifestYaml(t),
    });

    expect(registry.listTypes()).toEqual([]);
  });
});

describe("specialties option resolution", () => {
  it("defaults to specialist and the shipped agent-types/ with no env set", () => {
    expect(resolveDefaultSpecialtyName({})).toBe("specialist");
    expect(resolveSpecialtiesDir({})).toMatch(/agent-types$/);
  });

  it("honours SHIPWRIGHT_DEFAULT_AGENT_TYPE and SHIPWRIGHT_SPECIALTIES_DIR", () => {
    expect(
      resolveDefaultSpecialtyName({ SHIPWRIGHT_DEFAULT_AGENT_TYPE: "base" }),
    ).toBe("base");
    expect(
      resolveSpecialtiesDir({ SHIPWRIGHT_SPECIALTIES_DIR: "/tmp/types" }),
    ).toBe("/tmp/types");
  });

  it("falls back to the configured defaultTypeName for an unknown type", () => {
    const registry = new SpecialtyRegistry({
      read: (name) => {
        if (name === "base") return manifestYaml("base");
        throw new Error("ENOENT");
      },
      warn: () => {},
      defaultTypeName: "base",
    });
    expect(registry.getManifest("missing").metadata.name).toBe("base");
  });
});
