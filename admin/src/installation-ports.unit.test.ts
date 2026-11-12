/**
 * admin/src/installation-ports.unit.test.ts
 * Unit tests for the installation port over the GitHub client (fakes only).
 */

import { describe, expect, it } from "bun:test";
import enterpriseOrgInstallations from "./fixtures/enterprise-org-installations.json";
import {
  AppNotInstalledError,
  createInstallationPort,
  matchInstallation,
} from "./installation-ports.ts";

describe("enterprise-org-installations fixture", () => {
  it("has no app_id on any row (GitHub's schema omits it)", () => {
    expect(enterpriseOrgInstallations.length).toBeGreaterThan(0);
    for (const row of enterpriseOrgInstallations) {
      expect("app_id" in row).toBe(false);
      expect(typeof row.app_slug).toBe("string");
      expect(typeof row.client_id).toBe("string");
    }
  });
});

describe("matchInstallation", () => {
  const installs = [
    { id: 1, appId: 10, appSlug: "slug-one", clientId: "Iv1.aaa" },
    { id: 2, appId: 20, appSlug: "Slug-Two", clientId: "Iv1.bbb" },
    { id: 3, appSlug: "slug-three" },
  ];

  it("prefers client id over slug over appId", () => {
    expect(
      matchInstallation(installs, 10, { clientId: "Iv1.bbb", slug: "slug-one" })
        ?.id,
    ).toBe(2);
    expect(matchInstallation(installs, 10, { slug: "slug-three" })?.id).toBe(3);
    expect(matchInstallation(installs, 20)?.id).toBe(2);
  });

  it("falls through to the next key when one does not match", () => {
    expect(
      matchInstallation(installs, 10, { clientId: "Iv1.zzz", slug: "SLUG-TWO" })
        ?.id,
    ).toBe(2);
    expect(
      matchInstallation(installs, 20, { clientId: "Iv1.zzz", slug: "nope" })
        ?.id,
    ).toBe(2);
  });

  it("matches the slug case-insensitively", () => {
    expect(matchInstallation(installs, 99, { slug: "SLUG-ONE" })?.id).toBe(1);
  });

  it("never matches an installation without appId on appId alone", () => {
    expect(matchInstallation([{}], 0)).toBeUndefined();
    expect(matchInstallation(installs, 99, {})).toBeUndefined();
  });
});

describe("createInstallationPort", () => {
  const fake = (seen: string[]) =>
    createInstallationPort({
      listOrgInstallations: async () => [
        { id: 1, appSlug: "app-one" },
        { id: 2, appSlug: "app-two" },
      ],
      listInstallationRepositories: async (_o, id) => {
        seen.push(`list:${id}`);
        return [{ fullName: "acme/a" }];
      },
      addRepositories: async (_o, id, names) => {
        seen.push(`add:${id}:${names.join(",")}`);
      },
      removeRepositories: async (_o, id, names) => {
        seen.push(`rm:${id}:${names.join(",")}`);
      },
    });

  it("scopes to the identified App's installation per call and sends simple names", async () => {
    const seen: string[] = [];
    const port = fake(seen);
    expect(await port.listRepos(0, ["acme"], { slug: "app-two" })).toEqual({
      acme: ["acme/a"],
    });
    await port.addRepos(0, "acme", ["acme/b"], { slug: "APP-TWO" });
    await port.removeRepos(0, "acme", ["acme/c", "acme/d"], {
      slug: "app-one",
    });
    expect(seen).toEqual(["list:2", "add:2:b", "rm:1:c,d"]);
  });

  it("names the org when the App is not installed there", async () => {
    const port = fake([]);
    await expect(port.listRepos(99, ["acme"])).rejects.toThrow(
      /99.*not installed on org acme/,
    );
    await expect(port.listRepos(99, ["acme"])).rejects.toBeInstanceOf(
      AppNotInstalledError,
    );
  });
});
