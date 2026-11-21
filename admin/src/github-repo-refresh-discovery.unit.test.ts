/**
 * admin/src/github-repo-refresh-discovery.unit.test.ts
 * Target discovery for the GLC-1.4 refresher: orgs from the installer App (or
 * the lookup App's own installations), agents from stored Apps, scoping,
 * dedupe and failure isolation, against fake ports.
 */

import { describe, expect, it } from "bun:test";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import {
  createRefreshDiscovery,
  type DiscoveryPorts,
  type LookupAppClient,
  notFoundAsEmpty,
} from "./github-repo-refresh-discovery.ts";
import type { PageSource } from "./github-repo-crawler.ts";
import type { InstallationAgentRecord } from "./installation-ports.ts";

const clock = { now: () => new Date("2026-11-20T12:00:00Z") };

function lookupClient(installed: string[] = []): LookupAppClient {
  return {
    async listInstallations() {
      return installed.map((login, i) => ({ id: i + 1, login }));
    },
    async listInstallationRepositoriesPage() {
      throw new Error("not used");
    },
    async getCollaboratorPermissionWithRateLimit() {
      throw new Error("not used");
    },
  };
}

const agent = (
  over: Partial<InstallationAgentRecord> = {},
): InstallationAgentRecord => ({
  id: "a1",
  accountId: null,
  repos: [],
  githubUsername: null,
  ...over,
});

function ports(over: Partial<DiscoveryPorts> = {}): DiscoveryPorts {
  return {
    listAppScopes: async () => [],
    listAgents: async () => [],
    lookupApp: async () => ({
      accountId: null,
      appId: "555",
      client: lookupClient(),
    }),
    installerOrgs: async () => ["acme", "beta"],
    installer: {
      async listOrgInstallations() {
        return [];
      },
      async listInstallationRepositoriesPage() {
        throw new Error("not used");
      },
    },
    store: {} as DiscoveryPorts["store"],
    clock,
    log: () => {},
    ...over,
  };
}

const keys = (
  ts: {
    key: { accountId: string; appKind: string; appRef: string; org: string };
  }[],
) =>
  ts.map(
    (t) => `${t.key.accountId}|${t.key.appKind}|${t.key.appRef}|${t.key.org}`,
  );

describe("createRefreshDiscovery", () => {
  it("builds a lookup target per installer org and an agent target per agent App and org", async () => {
    const d = createRefreshDiscovery(
      ports({
        listAgents: async () => [
          agent({
            id: "a1",
            appId: 777,
            githubUsername: "Octocat",
            repos: ["acme/api", "beta/x", "ACME/web"],
          }),
          agent({ id: "a2", appId: 777, githubUsername: "octocat" }),
          agent({ id: "a3", githubUsername: "nobody-without-app" }),
        ],
      }),
    );
    const targets = await d.listTargets();
    expect(keys(targets)).toEqual([
      "deployment|lookup|555|acme",
      "deployment|lookup|555|beta",
      "deployment|agent|777|acme",
      "deployment|agent|777|beta",
    ]);
    const acme = targets[0];
    expect(acme?.access?.users).toEqual([
      { username: "Octocat", configuredRepos: ["api", "web"] },
      { username: "octocat", configuredRepos: [] },
    ]);
    expect(targets[2]?.access).toBeUndefined();
  });

  it("uses the lookup App's own installations when no installer is configured, with no agent targets", async () => {
    const d = createRefreshDiscovery(
      ports({
        installerOrgs: async () => null,
        lookupApp: async () => ({
          accountId: null,
          appId: "555",
          client: lookupClient(["solo"]),
        }),
        listAgents: async () => [agent({ appId: 777 })],
      }),
    );
    expect(keys(await d.listTargets())).toEqual(["deployment|lookup|555|solo"]);
  });

  it("gives an account with its own Apps its own scope and binds its agents there", async () => {
    const d = createRefreshDiscovery(
      ports({
        listAppScopes: async () => ["acc1"],
        lookupApp: async (scope) =>
          scope === "acc1"
            ? { accountId: "acc1", appId: "900", client: lookupClient() }
            : { accountId: null, appId: "555", client: lookupClient() },
        installerOrgs: async (scope) =>
          scope === "acc1" ? ["corp"] : ["acme"],
        listAgents: async () => [
          agent({
            id: "a1",
            accountId: "acc1",
            githubUsername: "alice",
            appId: 1,
          }),
          agent({
            id: "a2",
            accountId: "acc2",
            githubUsername: "bob",
            appId: 2,
          }),
        ],
      }),
    );
    const targets = await d.listTargets();
    expect(keys(targets)).toEqual([
      "deployment|lookup|555|acme",
      "acc1|lookup|900|corp",
      "acc1|agent|1|corp",
      // acc2 has no Apps of its own: the deployment pair, its own cache key.
      "acc2|agent|2|acme",
    ]);
    const byKey = Object.fromEntries(
      targets
        .filter((t) => t.key.appKind === "lookup")
        .map((t) => [`${t.key.accountId}|${t.key.org}`, t]),
    );
    expect(byKey["deployment|acme"]?.access?.users).toEqual([
      { username: "bob", configuredRepos: [] },
    ]);
    expect(byKey["acc1|corp"]?.access?.users).toEqual([
      { username: "alice", configuredRepos: [] },
    ]);
  });

  it("does not duplicate a scope that resolves to the deployment-wide Apps", async () => {
    const d = createRefreshDiscovery(
      ports({ listAppScopes: async () => ["acc-installer-only"] }),
    );
    expect(keys(await d.listTargets())).toEqual([
      "deployment|lookup|555|acme",
      "deployment|lookup|555|beta",
    ]);
  });

  it("skips a scope whose discovery fails without blocking the others", async () => {
    const lines: string[] = [];
    const d = createRefreshDiscovery(
      ports({
        listAppScopes: async () => ["broken"],
        lookupApp: async (scope) => {
          if (scope === "broken") throw new Error("key decrypt failed");
          return { accountId: null, appId: "555", client: lookupClient() };
        },
        log: (l) => lines.push(l),
      }),
    );
    expect(keys(await d.listTargets())).toEqual([
      "deployment|lookup|555|acme",
      "deployment|lookup|555|beta",
    ]);
    expect(lines.join("\n")).toContain("key decrypt failed");
  });

  it("returns nothing when no lookup or installer App is configured", async () => {
    const d = createRefreshDiscovery(
      ports({
        lookupApp: async () => null,
        installerOrgs: async () => null,
        listAgents: async () => [agent({ appId: 1 })],
      }),
    );
    expect(await d.listTargets()).toEqual([]);
  });
});

describe("notFoundAsEmpty", () => {
  it("turns a not_found (App not installed on the org) into an empty last page", async () => {
    const src: PageSource = {
      async fetchPage() {
        throw new GithubEnterpriseError("not_found", "no installation");
      },
    };
    expect(await notFoundAsEmpty(src).fetchPage(1)).toEqual({
      repos: [],
      totalCount: 0,
      hasNext: false,
    });
  });

  it("passes other errors through", async () => {
    const src: PageSource = {
      async fetchPage() {
        throw new GithubEnterpriseError("rate_limit", "slow down");
      },
    };
    await expect(notFoundAsEmpty(src).fetchPage(1)).rejects.toThrow(
      "slow down",
    );
  });
});
