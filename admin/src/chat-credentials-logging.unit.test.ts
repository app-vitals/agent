/**
 * Log-capture test for the chat-credentials routes (COS-32.1): the raw token
 * must never reach a log line, and each mint/revoke emits one structured line.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";

const RAW = "ct_super_secret_raw_token_value";

function makeApp() {
  const deps = {
    agentService: { exists: async () => true },
    agentTokenService: { validate: async () => null },
    agentMemberService: { listByEmail: async () => [] },
    adminApiKeys: parseAdminApiKeys("root:admin-key:*"),
    sessionSecret: "s".repeat(32),
    chatCredentialsEnabled: true,
    chatCredentials: {
      mintToken: async () => ({ id: "tok-1", rawToken: RAW }),
      revokeToken: async () => {},
      listTokensForAgent: async () => [{ id: "tok-1", label: "lbl" }],
    },
  } as unknown as AdminDeps;
  return createAdminApp(deps);
}

describe("chat-credentials logging", () => {
  let lines: string[];
  const spies: Array<{ mockRestore: () => void }> = [];
  beforeEach(() => {
    lines = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      spies.push(
        spyOn(console, m).mockImplementation((...a: unknown[]) => {
          lines.push(a.map(String).join(" "));
        }),
      );
    }
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  const req = (
    app: ReturnType<typeof makeApp>,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-key",
      },
    });

  it("mint and revoke each log one structured line without the raw token", async () => {
    const app = makeApp();
    const minted = await req(app, "POST", "/agents/a1/chat-credentials", {
      label: "lbl",
    });
    expect(minted.status).toBe(201);
    expect(((await minted.json()) as { rawToken: string }).rawToken).toBe(RAW);
    expect(
      (await req(app, "DELETE", "/agents/a1/chat-credentials/tok-1")).status,
    ).toBe(204);

    const events = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.event)).toEqual([
      "chat-credential.mint",
      "chat-credential.revoke",
    ]);
    for (const e of events) {
      expect(e).toMatchObject({
        agentId: "a1",
        tokenId: "tok-1",
        label: "lbl",
      });
      expect(typeof e.callerLabel).toBe("string");
    }
    expect(lines.join("\n")).not.toContain(RAW);
  });
});
