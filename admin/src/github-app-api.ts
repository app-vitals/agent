/**
 * admin/src/github-app-api.ts
 * Two small GitHub App reads that sit beside GithubEnterpriseClient:
 *
 *  - fetchPublicApp(slug): GET /apps/{slug}, unauthenticated. Returns the App's
 *    client id. A private App is 404 here (no credentials are sent).
 *  - fetchAuthenticatedApp(): GET /app with an app JWT. Returns the App's
 *    declared permissions; used to validate the 'lookup' role.
 *
 * Errors are GithubEnterpriseError (message redacted of the key); the key
 * never appears in a result or an error.
 */

import {
  GithubEnterpriseError,
  mapGithubEnterpriseError,
} from "./github-enterprise-client.ts";
import { signGithubAppJwt } from "./github-app-jwt.ts";

interface FetchOpts {
  apiBase?: string;
  fetchFn?: typeof fetch;
}

export interface PublicApp {
  slug: string;
  clientId: string | null;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  context: string,
  fetchFn: typeof fetch,
  secrets: readonly string[],
): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...headers,
      },
    });
  } catch {
    throw new GithubEnterpriseError("network", `${context}: network error`);
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    data = undefined;
  }
  if (!resp.ok) {
    throw mapGithubEnterpriseError(
      resp.status,
      resp.headers,
      data,
      context,
      secrets,
    );
  }
  return data;
}

/** GET /apps/{slug} (public). `slug` must already be validated. */
export async function fetchPublicApp(
  slug: string,
  opts: FetchOpts = {},
): Promise<PublicApp> {
  const data = (await getJson(
    `${opts.apiBase ?? "https://api.github.com"}/apps/${encodeURIComponent(slug)}`,
    {},
    "GitHub public App lookup",
    opts.fetchFn ?? fetch,
    [],
  )) as { slug?: unknown; client_id?: unknown } | undefined;
  return {
    slug: typeof data?.slug === "string" ? data.slug : slug,
    clientId:
      typeof data?.client_id === "string" && data.client_id
        ? data.client_id
        : null,
  };
}

/** GET /app with an app JWT: the App's own declared permissions. */
export async function fetchAuthenticatedApp(
  opts: FetchOpts & { appId: string; privateKey: string; now?: () => Date },
): Promise<{ permissions: Record<string, string> }> {
  const jwt = signGithubAppJwt({
    appId: opts.appId,
    privateKey: opts.privateKey,
    now: opts.now?.(),
  });
  const data = (await getJson(
    `${opts.apiBase ?? "https://api.github.com"}/app`,
    { Authorization: `Bearer ${jwt}` },
    "GitHub App lookup",
    opts.fetchFn ?? fetch,
    [jwt, opts.privateKey],
  )) as { permissions?: Record<string, string> } | undefined;
  return {
    permissions:
      data?.permissions && typeof data.permissions === "object"
        ? data.permissions
        : {},
  };
}
