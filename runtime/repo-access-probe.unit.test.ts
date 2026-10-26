/**
 * runtime/repo-access-probe.unit.test.ts
 * Probe behaviour via a routed fetch fake and an injected clock (COS-44.1).
 */

import { describe, expect, test } from "bun:test";
import {
  createRepoAccessProbe,
  createRepoAccessTokenFor,
  REPO_ACCESS_INTERVAL_MS,
} from "./repo-access-probe.ts";

const SECRET = "ghs_SUPERSECRETTOKEN";

type Route = Response | Error | ((req: { url: string }) => Response);

function harness(
  routes: Record<string, Route>,
  opts: { repos?: string[]; enabled?: boolean; token?: string | null } = {},
) {
  let nowMs = Date.UTC(2026, 0, 1);
  const calls: { url: string; auth: string | null }[] = [];
  const logs: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const state = {
    repos: opts.repos ?? ["acme/a"],
    enabled: opts.enabled ?? true,
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
    });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const route = routes[url.replace("https://api.github.com/repos/", "")];
    if (route instanceof Error) throw route;
    if (typeof route === "function") return route({ url });
    return route ?? new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const probe = createRepoAccessProbe({
    fetch: fetchFn,
    clock: { now: () => new Date(nowMs) },
    tokenFor: async () => (opts.token === undefined ? SECRET : opts.token),
    log: (m) => logs.push(m),
    getRepos: () => state.repos,
    isEnabled: () => state.enabled,
  });
  return {
    probe,
    calls,
    logs,
    state,
    maxInFlight: () => maxInFlight,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const ok = (pull: boolean, push: boolean) =>
  new Response(JSON.stringify({ permissions: { pull, push } }), {
    status: 200,
  });

describe("createRepoAccessProbe", () => {
  test("maps permissions.pull/push to read/write", async () => {
    const h = harness(
      {
        "acme/rw": ok(true, true),
        "acme/ro": ok(true, false),
      },
      { repos: ["acme/rw", "acme/ro"] },
    );
    const result = await h.probe.run();
    expect(result).toEqual([
      expect.objectContaining({
        repo: "ro",
        owner: "acme",
        read: true,
        write: false,
      }),
      expect.objectContaining({
        repo: "rw",
        owner: "acme",
        read: true,
        write: true,
      }),
    ]);
    expect(result?.every((r) => r.error === undefined)).toBe(true);
    expect(result?.[0]?.checkedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test.each([
    ["404", new Response("", { status: 404 }), "not_found"],
    ["403", new Response("", { status: 403 }), "forbidden"],
    [
      "403 with exhausted rate limit",
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
      "rate_limited",
    ],
    ["429", new Response("", { status: 429 }), "rate_limited"],
    ["network error", new Error("ECONNRESET"), "network"],
    ["5xx", new Response("", { status: 502 }), "network"],
  ] as const)(
    "%s -> read:false, write:false, error %s",
    async (_n, route, error) => {
      const h = harness({ "acme/a": route });
      const result = await h.probe.run();
      expect(result).toEqual([
        expect.objectContaining({
          repo: "a",
          read: false,
          write: false,
          error,
        }),
      ]);
    },
  );

  test("no credential for the owner -> forbidden without a fetch", async () => {
    const h = harness({}, { token: null });
    const result = await h.probe.run();
    expect(result?.[0]?.error).toBe("forbidden");
    expect(h.calls).toHaveLength(0);
  });

  test("feature off -> no calls and no result", async () => {
    const h = harness({ "acme/a": ok(true, true) }, { enabled: false });
    expect(await h.probe.run()).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  test("at most once per interval, again after it elapses", async () => {
    const h = harness({ "acme/a": ok(true, true) });
    expect(await h.probe.run()).toBeDefined();
    h.advance(REPO_ACCESS_INTERVAL_MS - 1);
    expect(await h.probe.run()).toBeUndefined();
    h.advance(1);
    expect(await h.probe.run()).toBeDefined();
    expect(h.calls).toHaveLength(2);
  });

  test("a scope change probes immediately", async () => {
    const h = harness({ "acme/a": ok(true, true), "acme/b": ok(true, false) });
    await h.probe.run();
    h.state.repos = ["acme/a", "acme/b"];
    const result = await h.probe.run();
    expect(result).toHaveLength(2);
    // Same set in a different order is not a change.
    h.state.repos = ["acme/b", "acme/a"];
    expect(await h.probe.run()).toBeUndefined();
  });

  test("concurrency is capped at 3", async () => {
    const repos = Array.from({ length: 8 }, (_, i) => `acme/r${i}`);
    const routes = Object.fromEntries(repos.map((r) => [r, ok(true, true)]));
    const h = harness(routes, { repos });
    await h.probe.run();
    expect(h.calls).toHaveLength(8);
    expect(h.maxInFlight()).toBe(3);
  });

  test("the token is sent only as a header and never logged or returned", async () => {
    const h = harness({
      "acme/a": new Error(`boom with ${SECRET}`),
    });
    const result = await h.probe.run();
    expect(h.calls[0]?.auth).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(h.logs.join("\n")).not.toContain(SECRET);
  });
});

describe("createRepoAccessTokenFor", () => {
  const manager = {
    getState: () => ({
      installations: [
        { id: 1, owner: "Acme", health: "ok" },
        { id: 2, owner: "dead", health: "broken" },
      ],
    }),
    getToken: async (id: number) => `inst-${id}`,
  };

  test("uses the matching healthy installation (case-insensitive)", async () => {
    const tokenFor = createRepoAccessTokenFor(() => manager, {
      GH_TOKEN: "pat",
    });
    expect(await tokenFor("acme")).toBe("inst-1");
  });

  test("falls back to the PAT, then null", async () => {
    expect(
      await createRepoAccessTokenFor(() => manager, { GH_TOKEN: "pat" })(
        "dead",
      ),
    ).toBe("pat");
    expect(
      await createRepoAccessTokenFor(() => null, { GH_TOKEN: "pat" })("x"),
    ).toBe("pat");
    expect(await createRepoAccessTokenFor(() => null, {})("x")).toBeNull();
  });
});
