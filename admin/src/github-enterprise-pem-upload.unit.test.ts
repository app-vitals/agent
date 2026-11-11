/**
 * admin/src/github-enterprise-pem-upload.unit.test.ts
 * Unit tests for the paste-or-upload private key parsing (GHE-1.12).
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  MAX_PEM_BYTES,
  readPrivateKeyField,
} from "./github-enterprise-pem-upload.ts";

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const formWith = (entries: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const pemFile = (body: string) =>
  new File([body], "app.private-key.pem", { type: "application/x-pem-file" });

describe("readPrivateKeyField", () => {
  it("returns an uploaded valid PEM unchanged", async () => {
    const r = await readPrivateKeyField(
      formWith({ privateKeyFile: pemFile(PEM) }),
    );
    expect(r).toEqual({ ok: true, pem: PEM });
  });

  it("accepts RSA and EC private key headers", async () => {
    for (const kind of ["RSA ", "EC ", ""]) {
      const body = `-----BEGIN ${kind}PRIVATE KEY-----\nQUJD\n-----END ${kind}PRIVATE KEY-----`;
      const r = await readPrivateKeyField(
        formWith({ privateKeyFile: pemFile(body) }),
      );
      expect(r.ok).toBe(true);
    }
  });

  it("prefers the file over pasted text", async () => {
    const r = await readPrivateKeyField(
      formWith({ privateKeyFile: pemFile(PEM), privateKey: "pasted" }),
    );
    expect(r).toEqual({ ok: true, pem: PEM });
  });

  it("passes pasted text through unchanged when no file is chosen", async () => {
    const r = await readPrivateKeyField(
      formWith({ privateKey: PEM, privateKeyFile: new File([], "") }),
    );
    expect(r).toEqual({ ok: true, pem: PEM });
  });

  it("stores CRLF uploads and pastes identically (LF)", async () => {
    const crlf = PEM.replace(/\n/g, "\r\n");
    const up = await readPrivateKeyField(
      formWith({ privateKeyFile: pemFile(crlf) }),
    );
    const paste = await readPrivateKeyField(formWith({ privateKey: crlf }));
    expect(up).toEqual({ ok: true, pem: PEM });
    expect(paste).toEqual(up);
  });

  it("rejects a non-PEM file without echoing its content", async () => {
    const r = await readPrivateKeyField(
      formWith({ privateKeyFile: pemFile("hunter2-SECRET not a key") }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("not a PEM private key");
      expect(r.error).not.toContain("hunter2");
    }
  });

  it("rejects a public key or certificate PEM", async () => {
    for (const kind of ["PUBLIC KEY", "CERTIFICATE"]) {
      const r = await readPrivateKeyField(
        formWith({
          privateKeyFile: pemFile(
            `-----BEGIN ${kind}-----\nQUJD\n-----END ${kind}-----`,
          ),
        }),
      );
      expect(r.ok).toBe(false);
    }
  });

  it("rejects an oversized file", async () => {
    const big = `${PEM}${"A".repeat(MAX_PEM_BYTES)}`;
    const r = await readPrivateKeyField(
      formWith({ privateKeyFile: pemFile(big) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too large");
  });

  it("rejects when neither a file nor text is provided", async () => {
    const r = await readPrivateKeyField(formWith({ privateKey: "  " }));
    expect(r.ok).toBe(false);
  });
});
