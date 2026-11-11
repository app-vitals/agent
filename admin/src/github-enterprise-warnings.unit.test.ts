/**
 * Unit tests for GHE-1.10 permission warnings: advisory only, never validity.
 */

import { describe, expect, it } from "bun:test";
import {
  GHE_WARNINGS,
  permissionWarnings,
  resolveValidation,
} from "./github-enterprise-warnings.ts";

describe("permissionWarnings", () => {
  it("installer: warns unless the repositories permission is write", () => {
    expect(permissionWarnings("installer", {})).toEqual([GHE_WARNINGS.installer_repositories_write]);
    expect(
      permissionWarnings("installer", { enterprise_organization_installation_repositories: "read" }),
    ).toHaveLength(1);
    expect(
      permissionWarnings("installer", { enterprise_organization_installation_repositories: "write" }),
    ).toEqual([]);
  });

  it("lookup: warns unless members is read or write", () => {
    expect(permissionWarnings("lookup", { metadata: "read" })).toEqual([GHE_WARNINGS.lookup_members_read]);
    expect(permissionWarnings("lookup", { members: "read" })).toEqual([]);
    expect(permissionWarnings("lookup", { members: "write" })).toEqual([]);
  });
});

describe("resolveValidation", () => {
  const installer = { name: "enterprise_organization_installations", levels: ["write"] };

  it("a warning never turns a valid result invalid", () => {
    const r = resolveValidation("installer", installer, {
      enterprise_organization_installations: "write",
    });
    expect(r.status).toBe("valid");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("a missing required permission stays missing_permission with warnings alongside", () => {
    const r = resolveValidation("installer", installer, {});
    expect(r.status).toBe("missing_permission");
    expect(r.error).toContain("enterprise_organization_installations");
  });

  it("validity is identical with and without the optional permissions", () => {
    const without = resolveValidation("installer", installer, {
      enterprise_organization_installations: "write",
    });
    const withAll = resolveValidation("installer", installer, {
      enterprise_organization_installations: "write",
      enterprise_organization_installation_repositories: "write",
    });
    expect(without.status).toBe(withAll.status);
    expect(withAll.warnings).toEqual([]);
  });
});
