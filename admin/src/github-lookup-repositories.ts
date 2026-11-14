/**
 * admin/src/github-lookup-repositories.ts
 * The lookup-App repository lister exposed to extensions as
 * AdminPlatformServices.githubLookup: every repository the lookup App can see,
 * across the organizations the installer App can reach.
 *
 * A GitHub failure rejects; it is never reported as an empty list. An org
 * without the lookup App installed (not_found) is skipped. The stored-App
 * wiring (key-bearing) lives in github-enterprise-api.ts.
 */

import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import type { LookupRepository } from "./github-lookup-client.ts";

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
