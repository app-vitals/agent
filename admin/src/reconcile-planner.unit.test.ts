import { describe, expect, test } from "bun:test";
import { planReconcile, type ReconcilePlanInput } from "./reconcile-planner.ts";
import {
  type OrgAccessResult,
  SELECTED_REPOS_REASON,
  type UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

const repo = (fullName: string, canPush: boolean) => ({
  fullName,
  canPush,
  level: canPush ? ("write" as const) : ("read" as const),
});

const org = (
  name: string,
  repos: ReturnType<typeof repo>[],
  extra: Partial<OrgAccessResult> = {},
): OrgAccessResult => ({
  org: name,
  status: "ok",
  repos,
  unresolved: 0,
  ...extra,
});

const access = (
  orgs: OrgAccessResult[],
  extra: Partial<UserRepoAccessResult> = {},
): UserRepoAccessResult => ({
  username: "octo",
  outcome: "ok",
  userVerified: true,
  orgs,
  unresolved: 0,
  complete: orgs.every((o) => o.status === "ok"),
  checkedAt: "2026-11-11T00:00:00.000Z",
  ...extra,
});

const base = (over: Partial<ReconcilePlanInput> = {}): ReconcilePlanInput => ({
  username: "octo",
  access: access([org("acme", [repo("acme/a", true), repo("acme/b", false)])]),
  agentRepos: ["acme/a", "acme/b"],
  installationRepos: { acme: ["acme/a", "acme/b"] },
  ...over,
});

describe("planReconcile", () => {
  test("removes repos the user cannot push to, from config and installation", () => {
    const p = planReconcile(base());
    expect(p.diff.configRemoves).toEqual(["acme/b"]);
    expect(p.diff.installationRemoves).toEqual(["acme/b"]);
    expect(p.diff.configAdds).toEqual([]);
  });

  test("never adds newly accessible repos that were not named", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [
            repo("acme/a", true),
            repo("acme/b", true),
            repo("acme/new", true),
          ]),
        ]),
      }),
    );
    expect(p.empty).toBe(true);
    expect(p.diff.configAdds).toEqual([]);
  });

  test("skips removals for a partial org with a reason", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [repo("acme/a", true)], {
            status: "partial",
            unresolved: 1,
          }),
        ]),
      }),
    );
    expect(p.diff.configRemoves).toEqual([]);
    expect(p.skippedOrgs).toEqual([
      { org: "acme", reason: "access listing is incomplete" },
    ]);
  });

  test("skips removals for failed and unchecked orgs", () => {
    const failed = planReconcile(
      base({ access: access([org("acme", [], { status: "error" })]) }),
    );
    expect(failed.diff.configRemoves).toEqual([]);
    expect(failed.skippedOrgs[0].reason).toContain("error");
    const unchecked = planReconcile(base({ access: access([]) }));
    expect(unchecked.diff.configRemoves).toEqual([]);
    expect(unchecked.skippedOrgs[0].reason).toBe("org was not checked");
  });

  test("skips removals for a selected-only lookup installation", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [repo("acme/a", true)], {
            status: "partial",
            reason: SELECTED_REPOS_REASON,
          }),
        ]),
      }),
    );
    expect(p.diff.configRemoves).toEqual([]);
    expect(p.skippedOrgs[0].reason).toContain("selected repositories");
  });

  test("only the incomplete org is skipped; other orgs still reconcile", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [repo("acme/a", true)], { status: "partial" }),
          org("beta", [repo("beta/x", false)]),
        ]),
        agentRepos: ["acme/b", "beta/x"],
        installationRepos: { acme: ["acme/b"], beta: ["beta/x"] },
      }),
    );
    expect(p.diff.configRemoves).toEqual(["beta/x"]);
    expect(p.skippedOrgs.map((s) => s.org)).toEqual(["acme"]);
  });

  test("named add: accepted when push-capable, installs when absent", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [
            repo("acme/a", true),
            repo("acme/c", true),
            repo("acme/b", true),
          ]),
        ]),
        namedAdds: ["acme/c"],
      }),
    );
    expect(p.diff.configAdds).toEqual(["acme/c"]);
    expect(p.diff.installationAdds).toEqual(["acme/c"]);
  });

  test("named add: rejected when not push-capable", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [repo("acme/a", true), repo("acme/c", false)]),
        ]),
        agentRepos: ["acme/a"],
        namedAdds: ["acme/c", "acme/unknown"],
      }),
    );
    expect(p.diff.configAdds).toEqual([]);
    expect(p.rejectedAdds.map((r) => r.repo)).toEqual([
      "acme/c",
      "acme/unknown",
    ]);
  });

  test("named add: rejected on basename collision with kept repo or another add", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [repo("acme/a", true)]),
          org("beta", [repo("beta/a", true), repo("beta/z", true)]),
          org("gamma", [repo("gamma/z", true)]),
        ]),
        agentRepos: ["acme/a"],
        installationRepos: { acme: ["acme/a"] },
        namedAdds: ["beta/a", "beta/z", "gamma/z"],
      }),
    );
    expect(p.diff.configAdds).toEqual(["beta/z"]);
    expect(p.rejectedAdds).toEqual([
      { repo: "beta/a", reason: "basename collides with acme/a" },
      { repo: "gamma/z", reason: "basename collides with beta/z" },
    ]);
  });

  test("a repo being removed does not block a colliding add", () => {
    const p = planReconcile(
      base({
        access: access([
          org("acme", [repo("acme/a", false)]),
          org("beta", [repo("beta/a", true)]),
        ]),
        agentRepos: ["acme/a"],
        installationRepos: { acme: ["acme/a"], beta: ["beta/a"] },
        namedAdds: ["beta/a"],
      }),
    );
    expect(p.diff.configRemoves).toEqual(["acme/a"]);
    expect(p.diff.configAdds).toEqual(["beta/a"]);
  });

  test("subset invariant: config repos missing from installation are dropped", () => {
    const p = planReconcile(
      base({ agentRepos: ["acme/a"], installationRepos: { acme: [] } }),
    );
    expect(p.diff.configRemoves).toEqual(["acme/a"]);
    expect(p.diff.installationRemoves).toEqual([]);
    expect(p.warnings.join()).toContain("not in the agent installation");
  });

  test("subset invariant: result is always within the installation", () => {
    const input = base({
      access: access([
        org("acme", [
          repo("acme/a", true),
          repo("acme/b", false),
          repo("acme/c", true),
        ]),
      ]),
      namedAdds: ["acme/c"],
    });
    const p = planReconcile(input);
    const installed = new Set(
      (input.installationRepos.acme ?? [])
        .filter((r) => !p.diff.installationRemoves.includes(r))
        .concat(p.diff.installationAdds),
    );
    const finalConfig = input.agentRepos
      .filter((r) => !p.diff.configRemoves.includes(r))
      .concat(p.diff.configAdds);
    for (const r of finalConfig) expect(installed.has(r)).toBe(true);
  });

  test("idempotent: reconciled state yields an empty diff and same hash", () => {
    const first = planReconcile(base());
    const reconciled = base({
      agentRepos: ["acme/a"],
      installationRepos: { acme: ["acme/a"] },
    });
    const second = planReconcile(reconciled);
    const third = planReconcile(reconciled);
    expect(first.empty).toBe(false);
    expect(second.empty).toBe(true);
    expect(second.planHash).toBe(third.planHash);
    expect(second.planHash).not.toBe(first.planHash);
  });

  test("hash is independent of input ordering", () => {
    const a = planReconcile(base({ agentRepos: ["acme/a", "acme/b"] }));
    const b = planReconcile(base({ agentRepos: ["acme/b", "acme/a"] }));
    expect(a.planHash).toBe(b.planHash);
  });

  test("unbound username yields a skipped plan", () => {
    for (const username of [null, undefined, "  "]) {
      const p = planReconcile(base({ username }));
      expect(p.skipped).toBe(true);
      expect(p.skipReason).toContain("no GitHub username");
      expect(p.empty).toBe(true);
    }
  });

  test("unresolved access, unknown user and unverified user skip the plan", () => {
    expect(planReconcile(base({ access: null })).skipped).toBe(true);
    expect(
      planReconcile(base({ access: access([], { outcome: "user_not_found" }) }))
        .skipped,
    ).toBe(true);
    const unverified = planReconcile(
      base({ access: access([], { userVerified: false }) }),
    );
    expect(unverified.skipped).toBe(true);
    expect(unverified.diff.configRemoves).toEqual([]);
  });
});
