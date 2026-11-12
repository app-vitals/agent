import { describe, expect, test } from "bun:test";
import {
  accessSkipReason,
  orgSkipReason,
  repoOrg,
} from "./repo-access-rules.ts";
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

describe("repoOrg", () => {
  test("returns the owner part of owner/repo", () => {
    expect(repoOrg("acme/a")).toBe("acme");
    expect(repoOrg("")).toBe("");
  });
});

describe("orgSkipReason", () => {
  test("a complete listing has no skip reason", () => {
    expect(orgSkipReason(org("acme", [repo("acme/a", true)]))).toBeUndefined();
  });

  test("an unchecked org is skipped", () => {
    expect(orgSkipReason(undefined)).toBe("org was not checked");
  });

  test("a selected-repositories-only lookup install is skipped", () => {
    const r = org("acme", [], { reason: SELECTED_REPOS_REASON });
    expect(orgSkipReason(r)).toContain("selected repositories only");
  });

  test("partial and failed listings are skipped", () => {
    expect(orgSkipReason(org("acme", [], { status: "partial" }))).toContain(
      "incomplete",
    );
    expect(orgSkipReason(org("acme", [], { status: "error" }))).toContain(
      "access lookup failed",
    );
  });
});

describe("accessSkipReason", () => {
  const ok = access([org("acme", [repo("acme/a", true)])]);

  test("a usable access result has no skip reason", () => {
    expect(accessSkipReason("octo", ok)).toBeUndefined();
  });

  test("an unbound or blank username is skipped", () => {
    for (const username of [undefined, null, "", "   "]) {
      expect(accessSkipReason(username, ok)).toContain("no GitHub username");
    }
  });

  test("unresolved access, unknown user and unverified user are skipped", () => {
    expect(accessSkipReason("octo", null)).toBe("access was not resolved");
    expect(
      accessSkipReason("octo", access([], { outcome: "user_not_found" })),
    ).toBe("GitHub user not found");
    expect(accessSkipReason("octo", access([], { userVerified: false }))).toBe(
      "GitHub user could not be verified",
    );
  });
});
