/**
 * admin/src/principals-api.unit.test.ts
 * /principals lookup routes (ACM-1.1): auth, validation, shapes.
 */

import { describe, expect, it } from "bun:test";
import { createPrincipalsApp } from "./principals-api.ts";

function build() {
  return createPrincipalsApp({
    lookup: {
      resolveMany: async (ids: string[]) => ({
        principals: ids.includes("m1")
          ? [{ id: "m1", type: "user" as const, email: "a@x.com" }]
          : [],
        notFound: ids.filter((i) => i !== "m1"),
      }),
      findIdByEmail: async (email: string) =>
        email.toLowerCase() === "a@x.com"
          ? { id: "m1", type: "user" as const, email: "a@x.com" }
          : null,
    },
    sessionSecret: "s".repeat(32),
    adminApiKeys: new Map([["k", { name: "t", scope: "*" }]]),
    agentTokenService: { validate: async () => null } as never,
  });
}
const headers = {
  Authorization: "Bearer k",
  "Content-Type": "application/json",
};

describe("principals API", () => {
  it("401s without credentials", async () => {
    const res = await build().request("/principals/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["m1"] }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /principals/lookup returns principals and notFound with 200", async () => {
    const res = await build().request("/principals/lookup", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: ["m1", "x"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principals: [{ id: "m1", type: "user", email: "a@x.com" }],
      notFound: ["x"],
    });
  });

  it("POST /principals/lookup 400s on a non-array body", async () => {
    const res = await build().request("/principals/lookup", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: "m1" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /principals/by-email resolves case-insensitively", async () => {
    const res = await build().request("/principals/by-email?email=A@X.com", {
      headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "m1",
      type: "user",
      email: "a@x.com",
    });
  });

  it("GET /principals/by-email 404s for an unknown email", async () => {
    const res = await build().request("/principals/by-email?email=q@x.com", {
      headers,
    });
    expect(res.status).toBe(404);
  });
});
