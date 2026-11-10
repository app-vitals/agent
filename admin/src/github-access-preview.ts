/**
 * admin/src/github-access-preview.ts
 * Result type and port for GET /agents/:id/github-access (GHE-2.4): a
 * read-only preview of the repos an agent's bound GitHub user can reach.
 * The implementation lives in github-enterprise-api.ts (the only module that
 * may read the App keys); agents-api.ts only sees this port.
 */

import type { UserRepoAccessResult } from "./user-repo-access-resolver.ts";

export type GithubAccessPreview =
  /** The installer or lookup App is not configured; GitHub was not called. */
  | { status: "unconfigured" }
  /** `access` is the resolver output, unchanged. */
  | { status: "ok" | "user_not_found"; access: UserRepoAccessResult };

export type GithubAccessPreviewFn = (
  username: string,
) => Promise<GithubAccessPreview>;
