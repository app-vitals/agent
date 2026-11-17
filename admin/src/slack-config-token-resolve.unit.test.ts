import { describe, expect, test } from "bun:test";
import {
  hasStoredSlackConfigToken,
  type SlackConfigTokenResolver,
  withSlackConfigToken,
} from "./slack-config-token.ts";

interface Row {
  accountId: string | null;
}

/** Fake resolver: rows by scope; records which scope minted tokens. */
function fake(rows: Row[]) {
  const used: Array<string | null> = [];
  const resolver = {
    get: async (accountId: string | null) =>
      rows.find((r) => r.accountId === accountId) ?? null,
    resolveForAccount: async (accountId: string) =>
      rows.find((r) => r.accountId === accountId) ??
      rows.find((r) => r.accountId === null) ??
      null,
    withSlackConfigAccessToken: async <T>(
      accountId: string | null,
      fn: (t: string) => Promise<T>,
    ) => {
      used.push(accountId);
      return fn(`minted-${accountId ?? "default"}`);
    },
  } as unknown as SlackConfigTokenResolver;
  return { resolver, used };
}

describe("hasStoredSlackConfigToken", () => {
  test("false without a resolver or rows", async () => {
    expect(await hasStoredSlackConfigToken(undefined, "a1")).toBe(false);
    expect(await hasStoredSlackConfigToken(fake([]).resolver, "a1")).toBe(
      false,
    );
  });
  test("true for the account row, the default row, and null account + default", async () => {
    expect(
      await hasStoredSlackConfigToken(
        fake([{ accountId: "a1" }]).resolver,
        "a1",
      ),
    ).toBe(true);
    expect(
      await hasStoredSlackConfigToken(
        fake([{ accountId: null }]).resolver,
        "a1",
      ),
    ).toBe(true);
    expect(
      await hasStoredSlackConfigToken(
        fake([{ accountId: null }]).resolver,
        null,
      ),
    ).toBe(true);
    expect(
      await hasStoredSlackConfigToken(
        fake([{ accountId: "a1" }]).resolver,
        null,
      ),
    ).toBe(false);
  });
});

describe("withSlackConfigToken", () => {
  test("a pasted token wins and never touches the resolver", async () => {
    const { resolver, used } = fake([{ accountId: "a1" }]);
    const got = await withSlackConfigToken(
      resolver,
      { pasted: " xoxe.xoxp-paste ", accountId: "a1" },
      async (t) => t,
    );
    expect(got).toBe("xoxe.xoxp-paste");
    expect(used).toEqual([]);
  });
  test("account row overrides the default row", async () => {
    const { resolver, used } = fake([{ accountId: null }, { accountId: "a1" }]);
    const got = await withSlackConfigToken(
      resolver,
      { accountId: "a1" },
      async (t) => t,
    );
    expect(got).toBe("minted-a1");
    expect(used).toEqual(["a1"]);
  });
  test("falls back to the default row", async () => {
    const { resolver, used } = fake([{ accountId: null }]);
    expect(
      await withSlackConfigToken(resolver, { accountId: "a9" }, async (t) => t),
    ).toBe("minted-default");
    expect(used).toEqual([null]);
  });
  test("throws when nothing resolves", async () => {
    await expect(
      withSlackConfigToken(
        fake([]).resolver,
        { accountId: "a1" },
        async (t) => t,
      ),
    ).rejects.toThrow(/No .*Slack config token/);
    await expect(
      withSlackConfigToken(undefined, {}, async (t) => t),
    ).rejects.toThrow(/No .*Slack config token/);
  });
});
