/**
 * admin/src/github-enterprise-warnings.ts
 * GHE-1.10: pure validation logic for the enterprise GitHub Apps. Optional
 * permission warnings are advisory: they are returned next to the result and
 * never influence `status`, so a deployment that was valid stays valid.
 * No key or token ever flows through here (only permission names/levels).
 */

export type GheRole = "installer" | "lookup";
export type GheValidationStatus = "valid" | "missing_permission" | "error";

/** Warning code -> message. Codes are stable; the UI carries them in a redirect. */
export const GHE_WARNINGS = {
  installer_repositories_write:
    "The installer App lacks enterprise_organization_installation_repositories (write). It is not needed yet but will be required for repository management.",
  lookup_members_read:
    "The lookup App lacks the Organization Members (read) permission. Validation still passes; grant it to let the lookup see organization membership.",
} as const;

export type GheWarningCode = keyof typeof GHE_WARNINGS;

export function warningCodeFor(message: string): GheWarningCode | undefined {
  return (Object.keys(GHE_WARNINGS) as GheWarningCode[]).find(
    (k) => GHE_WARNINGS[k] === message,
  );
}

export function permissionWarnings(
  role: GheRole,
  granted: Record<string, string>,
): string[] {
  if (role === "installer") {
    return granted.enterprise_organization_installation_repositories === "write"
      ? []
      : [GHE_WARNINGS.installer_repositories_write];
  }
  return ["read", "write"].includes(granted.members ?? "")
    ? []
    : [GHE_WARNINGS.lookup_members_read];
}

/** Status comes from the required permission only; warnings ride alongside. */
export function resolveValidation(
  role: GheRole,
  required: { name: string; levels: readonly string[] },
  granted: Record<string, string>,
): {
  status: "valid" | "missing_permission";
  error: string | null;
  warnings: string[];
} {
  const ok = required.levels.includes(granted[required.name] ?? "");
  return {
    status: ok ? "valid" : "missing_permission",
    error: ok
      ? null
      : `the App does not hold ${required.name} (${required.levels.join(" or ")})`,
    warnings: permissionWarnings(role, granted),
  };
}
