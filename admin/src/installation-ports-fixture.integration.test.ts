/**
 * admin/src/installation-ports-fixture.integration.test.ts
 * Installation ports driven by the synthetic enterprise-organization-installation
 * fixture (no app_id), mapped through the real client mapper. No network, no DB.
 */

import { describe, expect, it } from "bun:test";
import { toInstallation } from "./github-enterprise-client.ts";
import enterpriseOrgInstallations from "./fixtures/enterprise-org-installations.json";
import { createInstallationReposPort } from "./installation-repos-service.ts";
import {
  AppNotInstalledError,
  createInstallationPort,
} from "./installation-ports.ts";

const ORG = "example-org";
const CLIENT_ID = "Iv1.0000000000000000";
const SLUG = "example-agent-app";

function harness() {
  const calls: string[] = [];
  const port = createInstallationPort({
    listOrgInstallations: async () =>
      enterpriseOrgInstallations.map((r) =>
        toInstallation(r as Parameters<typeof toInstallation>[0]),
      ),
    listInstallationRepositories: async (_o, id) => {
      calls.push(`list:${id}`);
      return [{ fullName: `${ORG}/repo-a` }];
    },
    addRepositories: async (_o, id, names) => {
      calls.push(`add:${id}:${names.join(",")}`);
    },
    removeRepositories: async (_o, id, names) => {
      calls.push(`rm:${id}:${names.join(",")}`);
    },
  });
  const reposPort = createInstallationReposPort(port, {
    listInstallableOrganizations: async () => [{ login: ORG }],
  });
  return { calls, port, reposPort };
}

describe("installation ports with the no-app_id fixture", () => {
  for (const [label, identity] of [
    ["client id", { clientId: CLIENT_ID }],
    ["slug", { slug: SLUG.toUpperCase() }],
  ] as const) {
    it(`finds the installation by ${label}`, async () => {
      const { calls, port, reposPort } = harness();
      expect(await port.listRepos(7, [ORG], identity)).toEqual({
        [ORG]: [`${ORG}/repo-a`],
      });
      await port.addRepos(7, ORG, [`${ORG}/repo-b`], identity);
      await port.removeRepos(7, ORG, [`${ORG}/repo-c`], identity);
      expect(await reposPort.listInstalled(7, identity)).toEqual([
        { org: ORG, repos: [`${ORG}/repo-a`] },
      ]);
      expect(calls).toEqual([
        "list:1000001",
        "add:1000001:repo-b",
        "rm:1000001:repo-c",
        "list:1000001",
      ]);
    });
  }

  it("lists no orgs and throws for an agent with no identifier", async () => {
    const { port, reposPort } = harness();
    await expect(port.listRepos(7, [ORG])).rejects.toBeInstanceOf(
      AppNotInstalledError,
    );
    await expect(
      port.addRepos(7, ORG, [`${ORG}/x`], {}),
    ).rejects.toBeInstanceOf(AppNotInstalledError);
    expect(await reposPort.listInstalled(7)).toEqual([]);
  });
});
