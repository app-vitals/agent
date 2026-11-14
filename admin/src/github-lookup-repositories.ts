/**
 * admin/src/github-lookup-repositories.ts
 * The lookup-App repository lister exposed to extensions as
 * AdminPlatformServices.githubLookup: every repository the lookup App can see,
 * across the organizations the installer App can reach.
 *
 * Unconfigured (either App or key missing) answers `configured: false` with no
 * repos. A GitHub failure rejects; it is never reported as an empty list. An
 * org without the lookup App installed (not_found) is skipped.
 */

import type { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import {
  GithubEnterpriseClient,
  GithubEnterpriseError,
} from "./github-enterprise-client.ts";
import {
  GithubLookupClient,
  type LookupRepository,
} from "./github-lookup-client.ts";

export interface GithubLookupRepository {
  fullName: string;
  archived: boolean;
}

export interface GithubLookupRepositories {
  configured: boolean;
  repos: GithubLookupRepository[];
}

/** The extension-facing lister (optional member of AdminPlatformServices). */
export interface GithubLookupService {
  listRepositories(): Promise<GithubLookupRepositories>;
}

/** The installer-side client surface the lister needs. */
export interface LookupInstallerPort {
  listInstallableOrganizations(): Promise<{ login: string }[]>;
}

/** The lookup-side client surface the lister needs. */
export interface LookupRepositoriesPort {
  listInstallationRepositories(org: string): Promise<LookupRepository[]>;
}

export interface GithubLookupServiceDeps {
  appService: Pick<GitHubEnterpriseAppService, "get" | "getPrivateKey">;
  fetchFn?: typeof fetch;
  apiBase?: string;
  now?: () => Date;
  /** Test seam: replaces the clients built from the stored Apps. */
  clients?: { installer: LookupInstallerPort; lookup: LookupRepositoriesPort };
}

export async function listLookupRepositories(
  installer: LookupInstallerPort,
  lookup: LookupRepositoriesPort,
): Promise<GithubLookupRepository[]> {
  const repos = new Map<string, GithubLookupRepository>();
  for (const { login } of await installer.listInstallableOrganizations()) {
    let rows: LookupRepository[];
    try {
      rows = await lookup.listInstallationRepositories(login);
    } catch (e) {
      // No lookup App installation on this org: nothing to list.
      if (e instanceof GithubEnterpriseError && e.kind === "not_found")
        continue;
      throw e;
    }
    for (const r of rows) {
      repos.set(r.fullName, { fullName: r.fullName, archived: r.archived });
    }
  }
  return [...repos.values()];
}

export function createGithubLookupService(
  deps: GithubLookupServiceDeps,
): GithubLookupService {
  return {
    async listRepositories() {
      let clients = deps.clients;
      if (!clients) {
        const [installer, lookup] = await Promise.all([
          deps.appService.get("installer"),
          deps.appService.get("lookup"),
        ]);
        if (!installer || !lookup || !installer.enterpriseSlug) {
          return { configured: false, repos: [] };
        }
        const [installerKey, lookupKey] = await Promise.all([
          deps.appService.getPrivateKey("installer"),
          deps.appService.getPrivateKey("lookup"),
        ]);
        if (!installerKey || !lookupKey)
          return { configured: false, repos: [] };
        const common = {
          apiBase: deps.apiBase,
          fetchFn: deps.fetchFn,
          now: deps.now,
        };
        clients = {
          installer: new GithubEnterpriseClient({
            appId: installer.appId,
            enterprise: installer.enterpriseSlug,
            privateKey: installerKey,
            ...common,
          }),
          lookup: new GithubLookupClient({
            appId: lookup.appId,
            privateKey: lookupKey,
            ...common,
          }),
        };
      }
      return {
        configured: true,
        repos: await listLookupRepositories(clients.installer, clients.lookup),
      };
    },
  };
}
