/**
 * admin/src/github-app-jwt.unit.test.ts
 * Unit tests for the RS256 GitHub App JWT signer. The RSA key is generated
 * in-test; no network, no fixtures.
 */

import { describe, expect, it } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { signGithubAppJwt } from "./github-app-jwt.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const pkcs8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NOW = new Date("2026-11-09T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
}

describe("signGithubAppJwt", () => {
  const jwt = signGithubAppJwt({ appId: "12345", privateKey, now: NOW });
  const [h, p, s] = jwt.split(".") as [string, string, string];

  it("has three base64url segments with an RS256 header", () => {
    expect(jwt.split(".")).toHaveLength(3);
    expect(jwt).not.toMatch(/[+/=]/);
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("sets iss to the app id, iat backdated 60s and exp within GitHub's 10 minute cap", () => {
    const claims = decode(p) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(NOW_S - 60);
    expect(claims.exp).toBe(NOW_S + 540);
    expect(claims.exp - NOW_S).toBeLessThanOrEqual(600);
  });

  it("verifies against the matching public key", () => {
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        createPublicKey(publicKey),
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
  });

  it("fails verification against a different key", () => {
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        createPublicKey(pkcs8.publicKey),
        Buffer.from(s, "base64url"),
      ),
    ).toBe(false);
  });

  it("accepts PKCS#8 keys", () => {
    const j = signGithubAppJwt({
      appId: "1",
      privateKey: pkcs8.privateKey,
      now: NOW,
    });
    expect(j.split(".")).toHaveLength(3);
  });

  it("throws a key-free error for an invalid key", () => {
    const bad = "-----BEGIN RSA PRIVATE KEY-----\nSECRETGARBAGE\n-----END RSA PRIVATE KEY-----";
    let msg = "";
    try {
      signGithubAppJwt({ appId: "1", privateKey: bad, now: NOW });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("private key");
    expect(msg).not.toContain("SECRETGARBAGE");
  });

  it("rejects an empty app id", () => {
    expect(() =>
      signGithubAppJwt({ appId: "", privateKey, now: NOW }),
    ).toThrow();
  });
});
