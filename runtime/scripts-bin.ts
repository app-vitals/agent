import { join } from "node:path";

/**
 * Absolute path to the repo's `scripts/bin` directory (holds the git
 * credential helper). Lives in runtime/, so the root is one level up.
 * Shared by boot.ts and entrypoint-main.ts so the two can't drift.
 */
export const SCRIPTS_BIN = join(import.meta.dir, "..", "scripts", "bin");
