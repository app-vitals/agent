import { describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";

// Validation runs before any DB call, so a throwing proxy proves none happens.
const noDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db touched");
    },
  },
) as unknown as PrismaClient;
const svc = new GitHubRepoCacheService(noDb);
const key = {
  accountId: "a",
  appKind: "lookup" as const,
  appRef: "1",
  org: "o",
};

describe("GitHubRepoCacheService argument validation", () => {
  it("rejects a bad appKind", async () => {
    await expect(
      svc.upsertSnapshot({ ...key, appKind: "bogus" as never }),
    ).rejects.toThrow("appKind");
  });
  it("rejects empty key parts", async () => {
    await expect(svc.getSnapshot({ ...key, org: " " })).rejects.toThrow("org");
    await expect(svc.getSnapshot({ ...key, accountId: "" })).rejects.toThrow(
      "accountId",
    );
  });
  it("rejects a non-positive lease ttl and empty holder", async () => {
    await expect(svc.acquireLease("s", "h", 0)).rejects.toThrow("ttlMs");
    await expect(svc.acquireLease("s", "", 10)).rejects.toThrow("holder");
  });
  it("rejects an empty repo fullName", async () => {
    await expect(
      svc.upsertRepos("s", [{ githubId: 1, fullName: "" }]),
    ).rejects.toThrow("fullName");
  });
  it("rejects a bad access status", async () => {
    await expect(
      svc.upsertAccess({
        accountId: "a",
        org: "o",
        repo: "r",
        username: "u",
        canPush: true,
        status: "nope" as never,
      }),
    ).rejects.toThrow("status");
  });
  it("rejects a non-positive maxAgeMs", async () => {
    await expect(
      svc.findMissingOrExpiredAccess({
        accountId: "a",
        org: "o",
        username: "u",
        repos: ["r"],
        maxAgeMs: -1,
      }),
    ).rejects.toThrow("maxAgeMs");
  });
});
