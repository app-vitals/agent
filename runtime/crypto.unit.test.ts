/**
 * agent/src/runtime/crypto.unit.test.ts
 * Unit tests for runtime/crypto.ts (AES-256-GCM encrypt / decrypt).
 * Pure logic — no I/O, no DB, no network.
 */

import { describe, expect, it } from "bun:test";
import { decrypt, encrypt } from "./crypto.ts";

// ─── Test key ─────────────────────────────────────────────────────────────────
// A known 64-char hex key (32 bytes) for deterministic tests.
const TEST_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";
const OTHER_KEY =
  "0000000000000000000000000000000000000000000000000000000000000002";

/** Flips the final byte of a hex string so it always differs from the input. */
function flipLastByte(hex: string): string {
  const last = hex.slice(-2);
  return hex.slice(0, -2) + (last === "ff" ? "00" : "ff");
}

/** Returns an encrypted value with the part at `index` replaced via `mutate`. */
function tamperPart(
  encrypted: string,
  index: 0 | 1 | 2,
  mutate: (part: string) => string,
): string {
  const parts = encrypted.split(":");
  parts[index] = mutate(parts[index] ?? "");
  return parts.join(":");
}

describe("encrypt / decrypt (AES-256-GCM)", () => {
  describe("round trip", () => {
    it("round-trips a plain ASCII string", () => {
      const plaintext = "hello world";
      expect(decrypt(encrypt(plaintext, TEST_KEY), TEST_KEY)).toBe(plaintext);
    });

    it("round-trips an empty string", () => {
      expect(decrypt(encrypt("", TEST_KEY), TEST_KEY)).toBe("");
    });

    it("round-trips a unicode string", () => {
      const plaintext = "こんにちは世界 🌍 — café résumé naïve";
      expect(decrypt(encrypt(plaintext, TEST_KEY), TEST_KEY)).toBe(plaintext);
    });

    it("round-trips a large (64 KiB) value", () => {
      const plaintext = "x".repeat(64 * 1024);
      expect(decrypt(encrypt(plaintext, TEST_KEY), TEST_KEY)).toBe(plaintext);
    });
  });

  describe("random IV", () => {
    it("produces a different ciphertext on each call", () => {
      const enc1 = encrypt("same input", TEST_KEY);
      const enc2 = encrypt("same input", TEST_KEY);
      expect(enc1).not.toBe(enc2);
    });

    it("uses a different IV on each call", () => {
      const iv1 = encrypt("same input", TEST_KEY).split(":")[0];
      const iv2 = encrypt("same input", TEST_KEY).split(":")[0];
      expect(iv1).not.toBe(iv2);
    });
  });

  describe("format", () => {
    it("is iv:ciphertext:authTag (3 colon-separated hex parts)", () => {
      const parts = encrypt("test", TEST_KEY).split(":");
      expect(parts.length).toBe(3);
      for (const part of parts) {
        expect(part).toMatch(/^[0-9a-f]+$/);
      }
    });

    it("has a 12-byte IV (24 hex chars)", () => {
      expect(encrypt("test", TEST_KEY).split(":")[0]).toHaveLength(24);
    });

    it("has a 16-byte auth tag (32 hex chars)", () => {
      expect(encrypt("test", TEST_KEY).split(":")[2]).toHaveLength(32);
    });
  });

  describe("authentication failures", () => {
    it("throws when decrypting with the wrong key", () => {
      const encrypted = encrypt("secret", TEST_KEY);
      expect(() => decrypt(encrypted, OTHER_KEY)).toThrow();
    });

    it("throws when the ciphertext is tampered", () => {
      const tampered = tamperPart(encrypt("secret", TEST_KEY), 1, flipLastByte);
      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });

    it("throws when the auth tag is tampered", () => {
      const tampered = tamperPart(encrypt("secret", TEST_KEY), 2, flipLastByte);
      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });

    it("throws when the IV is tampered", () => {
      const tampered = tamperPart(encrypt("secret", TEST_KEY), 0, flipLastByte);
      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });
  });

  describe("malformed input", () => {
    it("throws on 1 part", () => {
      expect(() => decrypt("notvalid", TEST_KEY)).toThrow(
        "Invalid encrypted format",
      );
    });

    it("throws on 2 parts", () => {
      expect(() => decrypt("aa:bb", TEST_KEY)).toThrow(
        "Invalid encrypted format",
      );
    });

    it("throws on 4 parts", () => {
      expect(() => decrypt("aa:bb:cc:dd", TEST_KEY)).toThrow(
        "Invalid encrypted format",
      );
    });

    it("throws on an empty string", () => {
      expect(() => decrypt("", TEST_KEY)).toThrow("Invalid encrypted format");
    });
  });

  describe("invalid key length", () => {
    const validEncrypted = encrypt("secret", TEST_KEY);

    it("encrypt throws on a short key", () => {
      expect(() => encrypt("secret", "abcd")).toThrow();
    });

    it("encrypt throws on an empty key", () => {
      expect(() => encrypt("secret", "")).toThrow();
    });

    it("decrypt throws on a short key", () => {
      expect(() => decrypt(validEncrypted, "abcd")).toThrow();
    });

    it("decrypt throws on an empty key", () => {
      expect(() => decrypt(validEncrypted, "")).toThrow();
    });
  });
});
