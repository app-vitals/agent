/**
 * lib/redact.unit.test.ts
 * Transcript redaction (COS-43.1): live secret values + token shapes.
 */

import { describe, expect, it } from "bun:test";
import { redact, redactShapes, redactValues } from "./redact.ts";

const PLANTED: Record<string, string> = {
  "GitHub classic PAT": `ghp_${"A1b2C3d4E5".repeat(3)}`,
  "GitHub fine-grained PAT": `github_pat_${"a1B2c3D4_".repeat(4)}`,
  "Anthropic key": `sk-ant-api03-${"Zy9-x8_W7".repeat(4)}`,
  "OpenAI-style key": `sk-${"Qw3Er4Ty5U".repeat(3)}`,
  "Slack token": "xoxb-1234567890-abcdefghij",
  "AWS access key": "AKIAIOSFODNN7EXAMPLE",
  "PEM private key": [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAxyz",
    "abcdef==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"),
  "Bearer token": "Bearer abcdefghijklmnop1234.-_",
  JWT: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
};

describe("redactShapes", () => {
  for (const [name, token] of Object.entries(PLANTED)) {
    it(`redacts a ${name} and counts it`, () => {
      const out = redactShapes(`before ${token} after`);
      expect(out.text).not.toContain(token);
      expect(out.text).toContain("before ");
      expect(out.text).toContain(" after");
      expect(out.count).toBe(1);
    });
  }

  it("redacts the PEM body, not just the header", () => {
    const out = redactShapes(PLANTED["PEM private key"] as string);
    expect(out.text).not.toContain("MIIEowIBAAKCAQEAxyz");
    expect(out.text).not.toContain("END RSA PRIVATE KEY");
  });

  it("counts every occurrence", () => {
    const t = PLANTED["GitHub classic PAT"] as string;
    const out = redactShapes(`${t} and ${t}\n${PLANTED["AWS access key"]}`);
    expect(out.count).toBe(3);
    expect(out.text).not.toContain(t);
  });

  it("does not flag a sha256 hex digest or ordinary prose", () => {
    const sha = `${"a".repeat(8)}${"0123456789abcdef".repeat(3)}deadbeef`;
    const text = `commit ${sha} skipped the task-store; sk-short is fine`;
    const out = redactShapes(text);
    expect(out.text).toBe(text);
    expect(out.count).toBe(0);
  });
});

describe("redactValues", () => {
  it("replaces live SECRET_ENV_VARS values and counts them", () => {
    const env = { GH_TOKEN: "super-secret-gh-value", PATH: "/usr/bin" };
    const out = redactValues(
      "token=super-secret-gh-value again super-secret-gh-value /usr/bin",
      env,
    );
    expect(out.text).not.toContain("super-secret-gh-value");
    expect(out.text).toContain("/usr/bin");
    expect(out.count).toBe(2);
  });

  it("is a no-op with no live secrets", () => {
    expect(redactValues("hello", {})).toEqual({ text: "hello", count: 0 });
  });
});

describe("redact", () => {
  it("applies values then shapes and sums the counts", () => {
    const env = { SLACK_BOT_TOKEN: "plain-live-value-123" };
    const out = redact(
      `a plain-live-value-123 b ${PLANTED["GitHub classic PAT"]}`,
      env,
    );
    expect(out.count).toBe(2);
    expect(out.text).not.toContain("plain-live-value-123");
    expect(out.text).not.toContain("ghp_");
  });
});
