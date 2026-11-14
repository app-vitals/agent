/**
 * admin/src/agent-template-items.unit.test.ts
 * ATP-1.1: template item payload sealing.
 */

import { describe, expect, it } from "bun:test";
import {
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
