/**
 * admin/src/specialty-manifest-loader.ts
 *
 * SpecialtyRegistry — resolves an agent's stored `specialty` to its parsed
 * Specialty manifest by loading `{typesDir}/{specialty}/manifest.yaml` from
 * disk (typesDir defaults to the shipped agent-types/) and validating it via
 * parseSpecialtyManifest().
 *
 * This is the runtime source of truth for an agent's default system crons
 * (and, in time, its default plugins/tools/env contract). It replaces the
 * former hardcoded SYSTEM_CRONS array in admin/src/system-crons.ts.
 *
 * Defaults: the default type is `specialist` and the type directory is the
 * shipped `agent-types/` (both resolved by @app-vitals/agent-lib/default-specialty,
 * the single shared helper; SHIPWRIGHT_DEFAULT_AGENT_TYPE /
 * SHIPWRIGHT_SPECIALTIES_DIR override them).
 *
 * Fallback contract: getManifest() never throws. An unknown `specialty` (no
 * matching directory under the type dir) resolves to the default type's
 * manifest with a logged warning. If even the default cannot be loaded (bad
 * env override, missing/invalid manifest) it warns and returns a built-in
 * minimal manifest with no crons/plugins, so the boot-path
 * POST /agents/:id/crons/reconcile route never 5xxs over configuration.
 *
 * The class takes an injectable reader/warner so unit tests can drive it
 * without touching the filesystem (see agent-cron-jobs.unit.test.ts).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SPECIALTY_NAME,
  resolveDefaultSpecialtyName,
  resolveSpecialtiesDir,
} from "@app-vitals/agent-lib/default-specialty";
import {
  parseSpecialtyManifest,
  type SpecialtyManifest,
} from "./specialty-registry.ts";

export {
  DEFAULT_SPECIALTY_NAME,
  resolveDefaultSpecialtyName,
  resolveSpecialtiesDir,
};

/**
 * Built-in last-resort manifest: used only when the default type itself cannot
 * be loaded. Declares nothing (no crons, plugins, tools) so it never seeds
 * anything unexpected.
 */
const BUILT_IN_FALLBACK_MANIFEST_YAML = `apiVersion: shipwright.dev/v1alpha1
kind: Specialty
metadata:
  name: ${DEFAULT_SPECIALTY_NAME}
  displayName: Specialist Agent
  description: Built-in fallback used when the default specialty manifest cannot be loaded.
  version: 0.0.0
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
`;

/** Reads a manifest's raw YAML text for a type; throws if it does not exist. */
type ManifestReader = (specialty: string) => string;

/** Sink for the unknown-specialty warning (defaults to console.warn). */
type WarnFn = (message: string) => void;

/**
 * Lists the name of every discoverable specialty directory (e.g. the
 * names of the subdirectories under specialties/). Used by listTypes() to
 * discover candidates before resolving each one's manifest via `read`.
 */
type TypeDirLister = () => string[];

/** A discovered specialty, as surfaced to the new-specialty picker. */
export interface SpecialtyOption {
  name: string;
  displayName: string;
}

/** Default reader: loads {typesDir}/{specialty}/manifest.yaml from disk. */
export function defaultManifestReader(
  specialty: string,
  typesDir: string = resolveSpecialtiesDir(),
): string {
  return readFileSync(join(typesDir, specialty, "manifest.yaml"), "utf-8");
}

/** Default lister: the directory names under the specialties dir on disk. */
export function defaultTypeDirLister(
  typesDir: string = resolveSpecialtiesDir(),
): string[] {
  return readdirSync(typesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Interface the reconcile path depends on — kept narrow so tests can supply a
 * trivial double without constructing the real disk-backed registry.
 */
export interface SpecialtyManifestResolver {
  /**
   * Resolve `specialty` to its parsed manifest. Falls back to the default
   * type's manifest (with a warning) when the type is unknown, and to a
   * built-in empty-crons manifest (with a warning) if the default cannot load
   * either. Never throws.
   */
  getManifest(specialty: string): SpecialtyManifest;
  /**
   * Resolve `specialty` to its parsed manifest WITHOUT falling back to
   * the default type — returns undefined for an unknown type instead (the one exception
   * is the built-in default type when no specialty is discoverable, matching the
   * picker's fallback option). No warning is
   * logged (an unknown type here is an expected, callers-handle-it outcome,
   * not a degraded-boot condition). Used by POST /admin/agents to reject an
   * unknown requested `type` with 400 rather than silently seeding a
   * default-type agent under a different label.
   */
  tryGetManifest(specialty: string): SpecialtyManifest | undefined;
  /**
   * Discover every specialty directory (via the injected `list` fn) and
   * resolve each to its {name, displayName} for populating the new-agent
   * type picker. A directory whose manifest fails to load or parse is
   * skipped (not thrown) — the picker still renders every other valid type
   * rather than 500ing the whole /admin/agents/new page over one bad
   * manifest. Order matches the underlying `list` fn's order. Never throws:
   * a missing type dir is treated as empty (with a warning), and when no type
   * is discoverable the built-in default option is returned.
   */
  listTypes(): SpecialtyOption[];
  /**
   * True when an AdminExtension declares `specialty` via agentTypes() — a type
   * with no manifest that POST /admin/agents must still accept. Optional: the
   * disk-backed registry has none.
   */
  hasExtensionType?(specialty: string): boolean;
}

export class SpecialtyRegistry implements SpecialtyManifestResolver {
  private readonly read: ManifestReader;
  private readonly warn: WarnFn;
  private readonly list: TypeDirLister;
  private readonly defaultTypeName: string;
  private readonly typesDir: string;
  private readonly cache = new Map<string, SpecialtyManifest>();

  /**
   * `typesDir` and `defaultTypeName` default to SHIPWRIGHT_SPECIALTIES_DIR /
   * SHIPWRIGHT_DEFAULT_AGENT_TYPE, then to the shipped agent-types/
   * and "specialist". An injected `read`/`list` takes precedence over `typesDir`.
   */
  constructor(
    opts: {
      read?: ManifestReader;
      warn?: WarnFn;
      list?: TypeDirLister;
      typesDir?: string;
      defaultTypeName?: string;
    } = {},
  ) {
    const typesDir = opts.typesDir ?? resolveSpecialtiesDir();
    this.typesDir = typesDir;
    this.read = opts.read ?? ((name) => defaultManifestReader(name, typesDir));
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.list = opts.list ?? (() => defaultTypeDirLister(typesDir));
    this.defaultTypeName =
      opts.defaultTypeName ?? resolveDefaultSpecialtyName();
  }

  getManifest(specialty: string): SpecialtyManifest {
    const resolved = this.tryLoadSafe(specialty);
    if (resolved) return resolved;

    this.warn(
      `SpecialtyRegistry: unknown agent specialty "${specialty}" — ` +
        `falling back to "${this.defaultTypeName}" manifest`,
    );
    if (specialty !== this.defaultTypeName) {
      const fallback = this.tryLoadSafe(this.defaultTypeName);
      if (fallback) return fallback;
    }
    // Even the default is unloadable (bad SHIPWRIGHT_SPECIALTIES_DIR /
    // SHIPWRIGHT_DEFAULT_AGENT_TYPE override). Degrade to an empty manifest
    // rather than failing boot; the warning names the knobs to fix.
    this.warn(
      `SpecialtyRegistry: the default specialty "${this.defaultTypeName}" could not be loaded from "${this.typesDir}" — ` +
        "using a built-in manifest with no crons. Check SHIPWRIGHT_SPECIALTIES_DIR and SHIPWRIGHT_DEFAULT_AGENT_TYPE.",
    );
    return parseSpecialtyManifest(BUILT_IN_FALLBACK_MANIFEST_YAML);
  }

  /**
   * Resolve `specialty` without falling back to the default type — see the interface
   * doc comment. Thin public wrapper around the existing tryLoad() used
   * internally by getManifest().
   */
  tryGetManifest(specialty: string): SpecialtyManifest | undefined {
    const manifest = this.tryLoad(specialty);
    if (manifest || specialty !== DEFAULT_SPECIALTY_NAME) return manifest;
    // The picker offers the built-in default when nothing is discoverable, so
    // creating an agent with it must resolve too.
    return this.discoverOptions().length === 0
      ? parseSpecialtyManifest(BUILT_IN_FALLBACK_MANIFEST_YAML)
      : undefined;
  }

  listTypes(): SpecialtyOption[] {
    const options = this.discoverOptions();
    if (options.length > 0) return options;
    // Nothing discoverable: offer the built-in default so the picker is never empty.
    const fallback = parseSpecialtyManifest(BUILT_IN_FALLBACK_MANIFEST_YAML);
    return [
      {
        name: fallback.metadata.name,
        displayName: fallback.metadata.displayName,
      },
    ];
  }

  /** Every loadable specialty found on disk; empty when the dir is missing or has none. */
  private discoverOptions(): SpecialtyOption[] {
    let specialties: string[];
    try {
      specialties = this.list();
    } catch (err) {
      // Missing dir (e.g. npm consumers, where agent-types/ is not shipped).
      this.warn(
        `SpecialtyRegistry: could not list specialties under "${this.typesDir}" — ` +
          `treating as empty (${err instanceof Error ? err.message : String(err)})`,
      );
      specialties = [];
    }
    const options: SpecialtyOption[] = [];
    for (const specialty of specialties) {
      const manifest = this.tryLoad(specialty);
      if (!manifest) continue;
      options.push({
        name: manifest.metadata.name,
        displayName: manifest.metadata.displayName,
      });
    }
    return options;
  }

  /** tryLoad, but an invalid (unparseable) manifest also yields undefined. */
  private tryLoadSafe(specialty: string): SpecialtyManifest | undefined {
    try {
      return this.tryLoad(specialty);
    } catch {
      return undefined;
    }
  }

  /** Load + cache a manifest, returning undefined only if the file is missing. */
  private tryLoad(specialty: string): SpecialtyManifest | undefined {
    const cached = this.cache.get(specialty);
    if (cached) return cached;
    let raw: string;
    try {
      raw = this.read(specialty);
    } catch {
      return undefined;
    }
    return this.parseAndCache(specialty, raw);
  }

  private parseAndCache(specialty: string, raw: string): SpecialtyManifest {
    const manifest = parseSpecialtyManifest(raw);
    this.cache.set(specialty, manifest);
    return manifest;
  }
}
