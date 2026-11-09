/**
 * Unit tests for the GitHubEnterpriseApp serializer: metadata plus a
 * "key set" flag only, never the private key (plain or encrypted).
 */

import { describe, expect, it } from "bun:test";
import { toGitHubEnterpriseAppMetadata } from "./github-enterprise-apps.ts";

describe("toGitHubEnterpriseAppMetadata", () => {
  const row = {
    role: "installer",
    appId: "123",
    slug: "my-app",
    enterpriseSlug: "acme",
    privateKeyEncrypted: "aa:bb:cc",
    lastValidationStatus: "ok",
    lastValidatedAt: new Date("2026-01-01T00:00:00Z"),
    lastValidationError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
  };

  it("returns metadata and keySet, with no key material", () => {
    const out = toGitHubEnterpriseAppMetadata(row);
    expect(out.keySet).toBe(true);
    expect(out).toMatchObject({
      role: "installer",
      appId: "123",
      slug: "my-app",
    });
    expect(Object.keys(out).some((k) => /key/i.test(k) && k !== "keySet")).toBe(
      false,
    );
    expect(JSON.stringify(out)).not.toContain("aa:bb:cc");
  });

  it("keySet is false when no ciphertext is stored", () => {
    expect(
      toGitHubEnterpriseAppMetadata({ ...row, privateKeyEncrypted: "" }).keySet,
    ).toBe(false);
  });
});
