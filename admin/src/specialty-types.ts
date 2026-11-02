/**
 * admin/src/specialty-types.ts
 *
 * Resolves an agent's stored `specialty` to its type record. The platform has
 * one built-in type, `specialist` (lib/specialist-type.ts); every other valid
 * type is registered by an AdminExtension via agentTypes()
 * (admin-extension.ts), with its default crons/tools/plugins supplied by the
 * extension's specialtyDefaults() hook. The configured default type
 * (SHIPWRIGHT_DEFAULT_AGENT_TYPE) is also accepted so a platform-only
 * deployment can rename its default.
 *
 * Every type shares the specialist floor (tools, required env): getType()
 * never throws and resolves any stored value, including legacy ones, to it, so
 * the boot-path cron reconcile and the missing-required-env report cannot fail
 * over a stale specialty.
 */

import {
  DEFAULT_SPECIALTY_NAME,
  resolveDefaultSpecialtyName,
  resolveSpecialtiesDir,
} from "@app-vitals/agent-lib/default-specialty";
import {
  SPECIALIST_TYPE,
  type SpecialtyType,
} from "@app-vitals/agent-lib/specialist-type";

export type { SpecialtyType };
export {
  DEFAULT_SPECIALTY_NAME,
  resolveDefaultSpecialtyName,
  resolveSpecialtiesDir,
  SPECIALIST_TYPE,
};

/** A type offered by the new-agent picker. */
export interface SpecialtyOption {
  name: string;
  displayName: string;
}

/**
 * Interface the create, reconcile and picker paths depend on — kept narrow so
 * tests can supply a trivial double.
 */
export interface SpecialtyTypeResolver {
  /** Resolve `specialty` to its type record; unknown values get the specialist floor. Never throws. */
  getType(specialty: string): SpecialtyType;
  /**
   * Resolve `specialty` WITHOUT falling back: undefined for a type that is
   * neither built in nor the configured default. POST /admin/agents uses it to
   * reject an unknown requested type with 400.
   */
  tryGetType(specialty: string): SpecialtyType | undefined;
  /** The built-in types for the new-agent picker (extension types are merged in by withExtensionAgentTypes). */
  listTypes(): SpecialtyOption[];
  /** True when an AdminExtension declares `specialty` via agentTypes(). Optional: the built-in resolver has none. */
  hasExtensionType?(specialty: string): boolean;
}

export class SpecialtyTypes implements SpecialtyTypeResolver {
  private readonly defaultTypeName: string;

  constructor(opts: { defaultTypeName?: string } = {}) {
    this.defaultTypeName =
      opts.defaultTypeName ?? resolveDefaultSpecialtyName();
  }

  getType(_specialty: string): SpecialtyType {
    return SPECIALIST_TYPE;
  }

  tryGetType(specialty: string): SpecialtyType | undefined {
    return specialty === SPECIALIST_TYPE.name ||
      specialty === this.defaultTypeName
      ? SPECIALIST_TYPE
      : undefined;
  }

  listTypes(): SpecialtyOption[] {
    const options: SpecialtyOption[] = [
      { name: SPECIALIST_TYPE.name, displayName: SPECIALIST_TYPE.displayName },
    ];
    if (this.defaultTypeName !== SPECIALIST_TYPE.name) {
      options.push({
        name: this.defaultTypeName,
        displayName: this.defaultTypeName,
      });
    }
    return options;
  }
}
