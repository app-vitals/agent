/**
 * Baked marketplace reporter — at boot, lists the marketplace directories
 * baked into the image (BAKED_MARKETPLACES_ROOT) and reports their names to
 * admin: PUT /agents/:agentId/baked-marketplaces (overwrite). Read-only
 * visibility: admin stores the list so the UI can show what the image ships.
 *
 * Fire-and-forget: never throws; non-2xx and thrown errors are swallowed with
 * console.warn. The payload is the directory basenames only.
 */

import { basename } from "node:path";
import { BAKED_MARKETPLACES_ROOT, discoverBakedMarketplaces } from "./setup.ts";

const REQUEST_TIMEOUT_MS = 10_000;

interface ReportBakedMarketplacesOptions {
  apiUrl: string;
  agentId: string;
  apiKey: string;
  root?: string;
  fetchFn?: typeof fetch;
}

export async function reportBakedMarketplaces(
  opts: ReportBakedMarketplacesOptions,
): Promise<void> {
  const url = `${opts.apiUrl}/agents/${opts.agentId}/baked-marketplaces`;
  try {
    const names = discoverBakedMarketplaces(
      opts.root ?? BAKED_MARKETPLACES_ROOT,
    ).map((dir) => basename(dir));
    const res = await (opts.fetchFn ?? fetch)(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ names }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[baked-marketplaces-reporter] PUT ${url} returned ${res.status} — swallowing`,
      );
    }
  } catch (err) {
    console.warn(
      `[baked-marketplaces-reporter] PUT ${url} failed: ${String(err)} — swallowing`,
    );
  }
}
