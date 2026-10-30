/**
 * admin/src/specialty-defaults.ts
 *
 * The shape of a specialty's default crons, tools and plugins as supplied by
 * an AdminExtension's specialtyDefaults() hook (admin-extension.ts). The cron
 * reconcile (agent-cron-jobs.ts) and create-time seeding (agents.ts) consult
 * the hook first and fall back to the specialty manifest when it returns
 * nothing. Kept in its own module so those services can name the types without
 * importing admin-extension.ts.
 */

/** A default cron template; same fields as a manifest cron, defaults optional. */
export interface SpecialtyDefaultCron {
  name: string;
  schedule: string;
  prompt: string;
  preCheck?: string;
  silent?: boolean;
  /** Initial enabled state for a newly created row; defaults to true. */
  enabled?: boolean;
  /** Name of another cron in this same list. */
  parentCron?: string;
}

/** Any field left undefined falls back to the manifest for that field. */
export interface SpecialtyDefaults {
  crons?: readonly SpecialtyDefaultCron[];
  tools?: readonly string[];
  plugins?: readonly string[];
}

/** Resolves a specialty name to extension-supplied defaults, if any. */
export type SpecialtyDefaultsResolver = (
  specialty: string,
) => SpecialtyDefaults | undefined;
