/**
 * admin/src/installation-ports.unit.test.ts
 * Unit tests for the installation port over the GitHub client (fakes only).
 */

import { describe, expect, it } from "bun:test";
import {
  AppNotInstalledError,
  createInstallationPort,
} from "./installation-ports.ts";

describe("createInstallationPort", () => {
  it("scopes to the given App's installation per call and sends simple names", async () => {
    const seen: string[] = [];
    const port = createInstallationPort({
      listOrgInstallations: async () => [
        { id: 1, appId: 10 },
        { id: 2, appId: 20 },
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
    expect(await port.listRepos(20, ["acme"])).toEqual({ acme: ["acme/a"] });
    await port.addRepos(20, "acme", ["acme/b"]);
    await port.removeRepos(10, "acme", ["acme/c", "acme/d"]);
    expect(seen).toEqual(["list:2", "add:2:b", "rm:1:c,d"]);
  });

  it("names the org when the App is not installed there", async () => {
    const port = createInstallationPort({
      listOrgInstallations: async () => [{ id: 1, appId: 10 }],
      listInstallationRepositories: async () => [],
      addRepositories: async () => {},
      removeRepositories: async () => {},
    });
    await expect(port.listRepos(99, ["acme"])).rejects.toThrow(
      /99.*not installed on org acme/,
    );
    await expect(port.listRepos(99, ["acme"])).rejects.toBeInstanceOf(
      AppNotInstalledError,
    );
  });
});
