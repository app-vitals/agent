/**
 * Unit tests for reportBakedMarketplaces: reads the baked marketplace dirs,
 * PUTs the names once, and never throws.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportBakedMarketplaces } from "./baked-marketplaces-reporter.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function bakedRoot(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "baked-"));
  roots.push(root);
  for (const n of names) {
    mkdirSync(join(root, n, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, n, ".claude-plugin", "marketplace.json"), "{}");
  }
  return root;
}

function harness(response: Response | Error = new Response("{}")) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { calls, fetchFn };
}

const base = { apiUrl: "http://admin", agentId: "a1", apiKey: "k" };

describe("reportBakedMarketplaces", () => {
  test("PUTs the basenames once with the agent key", async () => {
    const root = bakedRoot(["vitals-os", "shipwright"]);
    const { calls, fetchFn } = harness();
    await reportBakedMarketplaces({ ...base, root, fetchFn });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://admin/agents/a1/baked-marketplaces");
    expect(calls[0].init?.method).toBe("PUT");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer k",
    );
    const body = JSON.parse(calls[0].init?.body as string);
    expect([...body.names].sort()).toEqual(["shipwright", "vitals-os"]);
  });

  test("reports an empty list when the root is missing", async () => {
    const { calls, fetchFn } = harness();
    await reportBakedMarketplaces({
      ...base,
      root: "/nonexistent-baked-root",
      fetchFn,
    });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ names: [] });
  });

  test("swallows a non-2xx response", async () => {
    const { fetchFn } = harness(new Response("no", { status: 500 }));
    await expect(
      reportBakedMarketplaces({ ...base, root: bakedRoot(["x"]), fetchFn }),
    ).resolves.toBeUndefined();
  });

  test("swallows a thrown fetch error", async () => {
    const { fetchFn } = harness(new Error("boom"));
    await expect(
      reportBakedMarketplaces({ ...base, root: bakedRoot(["x"]), fetchFn }),
    ).resolves.toBeUndefined();
  });
});
