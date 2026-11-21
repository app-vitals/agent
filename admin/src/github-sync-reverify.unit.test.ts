import { describe, expect, it } from "bun:test";
import {
  GithubSyncService,
  REVERIFY_FAILED_REASON,
  STILL_PUSHABLE_REASON,
} from "./github-sync.ts";
import type { InstallationCachePort } from "./installation-repos-service.ts";
import { MAX_UNCONFIRMED_REMOVALS } from "./installation-ports.ts";

const NOW = new Date("2026-11-21T00:00:00.000Z");
const names = (n: number) => Array.from({ length: n }, (_, i) => `acme/r${i}`);

function build(
  repos: string[],
  verify: (repo: string) => Promise<boolean | undefined>,
) {
  const removed: string[][] = [];
  const cache: InstallationCachePort = {
    listAgentSnapshots: async () => [
      {
        org: "acme",
        completedAt: NOW,
        totalCount: repos.length,
        lastError: null,
        rateLimitResetAt: null,
        repos: repos.map((fullName) => ({ fullName })),
      },
    ],
    getAccessRows: async () =>
      repos.map((f) => ({
        repo: f.slice(5),
        status: "ok",
        canPush: false,
        level: "none",
        checkedAt: NOW,
      })),
  };
  const svc = new GithubSyncService({
    agents: {
      get: async () => ({
        id: "ag",
        githubUsername: "octo",
        appId: 7,
        repos: [],
      }),
      setRepos: async () => {},
    },
    access: async () => {
      throw new Error("live resolver must not be called");
    },
    cache,
    now: () => NOW,
    verifyPush: (_u, repo) => verify(repo),
    installation: {
      listInstalled: async () => ({
        status: "found",
        orgs: [{ org: "acme", repos }],
      }),
      addRepos: async () => {},
      removeRepos: async (_a, _o, r) => {
        removed.push([...r]);
      },
    },
    audit: { write: async () => "audit-1" },
  });
  return { svc, removed };
}

const input = (appRemoves: string[], extra = {}) => ({
  agentId: "ag",
  caller: "root",
  appAdds: [],
  appRemoves,
  agentRemoves: [],
  ...extra,
});

describe("GithubSyncService live re-verify of removals", () => {
  it("removes only candidates the live call says cannot push, one call each", async () => {
    const calls: string[] = [];
    const { svc, removed } = build(["acme/a", "acme/b"], async (r) => {
      calls.push(r);
      return false;
    });
    const res = await svc.apply(input(["acme/a", "acme/b"]));
    expect(res.status).toBe("applied");
    expect(calls).toEqual(["acme/a", "acme/b"]);
    expect(removed).toEqual([["acme/a", "acme/b"]]);
  });

  it("drops a candidate that is still pushable and reports it", async () => {
    const { svc, removed } = build(
      ["acme/a", "acme/b"],
      async (r) => r === "acme/a",
    );
    const res = await svc.apply(input(["acme/a", "acme/b"]));
    if (res.status !== "applied") throw new Error(res.status);
    expect(removed).toEqual([["acme/b"]]);
    expect(res.plan.notApplied).toEqual([
      { repo: "acme/a", reason: STILL_PUSHABLE_REASON },
    ]);
  });

  it("drops a candidate when the call returns undefined or throws (unknown is never none)", async () => {
    const { svc, removed } = build(["acme/a", "acme/b"], async (r) => {
      if (r === "acme/b") throw new Error("boom");
      return undefined;
    });
    const res = await svc.apply(input(["acme/a", "acme/b"]));
    if (res.status !== "noop") throw new Error(res.status);
    expect(removed).toEqual([]);
    expect(res.plan.notApplied.map((n) => n.reason)).toEqual([
      REVERIFY_FAILED_REASON,
      REVERIFY_FAILED_REASON,
    ]);
  });

  it("preview makes no live calls", async () => {
    let calls = 0;
    const { svc } = build(["acme/a"], async () => {
      calls += 1;
      return false;
    });
    const r = await svc.preview("ag");
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.appRemoves).toEqual(["acme/a"]);
    expect(calls).toBe(0);
  });

  it("the removal cap counts what survives the re-check", async () => {
    const repos = names(MAX_UNCONFIRMED_REMOVALS + 1);
    const { svc } = build(repos, async (r) => r === repos[0]);
    const res = await svc.apply(input(repos));
    expect(res.status).toBe("applied");
    const { svc: svc2 } = build(repos, async () => false);
    expect((await svc2.apply(input(repos))).status).toBe("removal_cap");
  });
});
