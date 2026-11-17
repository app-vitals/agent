/**
 * admin/src/agent-template-items.unit.test.ts
 * ATP-1.1: template item payload sealing.
 */

import { describe, expect, it } from "bun:test";
import {
  AGENT_TEMPLATE_ITEM_KINDS,
  assertMarketplaceTemplateItem,
  assertTemplateEnvKeyAllowed,
  openTemplateItemPayload,
  sealTemplateItemPayload,
} from "./agent-template-items.ts";
import { UnprocessableEntityError } from "./errors.ts";
import { makeStrictTokenCrypto } from "./token-crypto.ts";

const crypto = makeStrictTokenCrypto("ab".repeat(32));
if (!crypto) throw new Error("test key rejected");

describe("sealTemplateItemPayload", () => {
  it("encrypts an env item's value and keeps other fields", () => {
    const sealed = sealTemplateItemPayload(
      "env",
      { value: "s3cret", secret: true },
      crypto,
    );
    expect(sealed.secret).toBe(true);
    expect(sealed.value).not.toBe("s3cret");
    expect(String(sealed.value).split(":")).toHaveLength(3);
    expect(openTemplateItemPayload("env", sealed, crypto)).toEqual({
      value: "s3cret",
      secret: true,
    });
  });

  it("does not mutate the input payload", () => {
    const payload = { value: "v" };
    sealTemplateItemPayload("env", payload, crypto);
    expect(payload).toEqual({ value: "v" });
  });

  it("rejects an env payload without a string value", () => {
    expect(() => sealTemplateItemPayload("env", {}, crypto)).toThrow(
      UnprocessableEntityError,
    );
    expect(() => sealTemplateItemPayload("env", { value: 1 }, crypto)).toThrow(
      UnprocessableEntityError,
    );
  });

  it("passes non-env kinds through unchanged", () => {
    const payload = { schedule: "0 9 * * *", prompt: "hi", value: "x" };
    for (const kind of ["tool", "plugin", "cron"] as const) {
      expect(sealTemplateItemPayload(kind, payload, crypto)).toBe(payload);
      expect(openTemplateItemPayload(kind, payload, crypto)).toBe(payload);
    }
  });
});

describe("assertTemplateEnvKeyAllowed", () => {
  it("rejects per-agent credential keys, case-insensitively", () => {
    for (const key of ["SLACK_BOT_TOKEN", "gh_token", "ANTHROPIC_API_KEY"]) {
      expect(() => assertTemplateEnvKeyAllowed(key)).toThrow(
        UnprocessableEntityError,
      );
    }
  });

  it("allows ordinary keys", () => {
    expect(() => assertTemplateEnvKeyAllowed("LINEAR_API_KEY")).not.toThrow();
  });
});

describe("marketplace template items", () => {
  it("lists marketplace as an item kind and stores it unencrypted", () => {
    expect(AGENT_TEMPLATE_ITEM_KINDS).toContain("marketplace");
    const payload = { source: "example-org/plugins", ref: "v1" };
    expect(sealTemplateItemPayload("marketplace", payload, crypto)).toBe(
      payload,
    );
    expect(openTemplateItemPayload("marketplace", payload, crypto)).toBe(
      payload,
    );
  });

  it("accepts a valid name, source and ref (ref optional or null)", () => {
    expect(() =>
      assertMarketplaceTemplateItem("example-plugins", {
        source: "example-org/plugins",
      }),
    ).not.toThrow();
    expect(() =>
      assertMarketplaceTemplateItem("m.1_x", {
        source: "https://git.example.com/org/repo.git",
        ref: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertMarketplaceTemplateItem("m", { source: "o/r", ref: "main" }),
    ).not.toThrow();
  });

  it("returns the per-agent API's 422 messages", () => {
    expect(() =>
      assertMarketplaceTemplateItem("m", {
        source: "https://user:pw@example.com/o/r",
      }),
    ).toThrow(
      "source must be a GitHub 'owner/repo' or an https git URL without credentials",
    );
    expect(() =>
      assertMarketplaceTemplateItem("m", { source: "not a repo" }),
    ).toThrow(UnprocessableEntityError);
    expect(() =>
      assertMarketplaceTemplateItem("-bad name", { source: "o/r" }),
    ).toThrow(
      "name must start with a letter or digit and contain only letters, digits, '.', '_' and '-'",
    );
    expect(() =>
      assertMarketplaceTemplateItem("m", { source: "o/r", ref: "a..b" }),
    ).toThrow("ref must be a plain branch, tag or sha");
  });
});
