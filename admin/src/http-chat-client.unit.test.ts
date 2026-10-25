/**
 * admin/src/http-chat-client.unit.test.ts
 * Pure unit tests for the read-side helpers in http-chat-client.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type ChatMessage,
  filterSince,
  HttpChatClient,
} from "./http-chat-client.ts";

const cassette: Record<string, { status: number; body: unknown }> = JSON.parse(
  readFileSync(
    new URL("./fixtures/http-chat-client-cassette.json", import.meta.url)
      .pathname,
    "utf-8",
  ),
);

/** HttpChatClient over an injected fetchFn replaying one cassette entry. */
function cassetteClient(key: string) {
  const entry = cassette[key];
  if (!entry) throw new Error(`cassette key not found: ${key}`);
  const bodies: unknown[] = [];
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    client: new HttpChatClient("https://chat.example.com", "admin-token", {
      fetchFn,
    }),
    bodies,
  };
}

function msg(id: string): ChatMessage {
  return {
    id,
    threadId: "t",
    role: "user",
    body: id,
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };
}

describe("filterSince (CFB-2.3 incremental ?since polling)", () => {
  const messages = [msg("a"), msg("b"), msg("c"), msg("d")];

  test("returns only messages after the given id", () => {
    expect(filterSince(messages, "b").map((m) => m.id)).toEqual(["c", "d"]);
  });

  test("returns empty when since is the last message", () => {
    expect(filterSince(messages, "d")).toEqual([]);
  });

  test("returns the full list when the since id is not found (re-sync)", () => {
    expect(filterSince(messages, "zzz").map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("returns everything after the first when since is the first id", () => {
    expect(filterSince(messages, "a").map((m) => m.id)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });
});

describe("HttpChatClient.createThread ask fields (COS-31.1)", () => {
  test("sends kind, askFromAgentId and askDepth when given", async () => {
    const { client, bodies } = cassetteClient("createThread_ask_success");
    const thread = await client.createThread("agent-123", {
      title: "ask from agent-456 - 2026-01-03T00:00:00.000Z",
      kind: "ask",
      askFromAgentId: "agent-456",
      askDepth: 1,
    });
    expect(bodies).toEqual([
      {
        agentId: "agent-123",
        title: "ask from agent-456 - 2026-01-03T00:00:00.000Z",
        kind: "ask",
        askFromAgentId: "agent-456",
        askDepth: 1,
      },
    ]);
    expect(thread).toMatchObject({
      id: "thread_ask",
      kind: "ask",
      askFromAgentId: "agent-456",
      askDepth: 1,
    });
  });

  test("omits the ask fields when not given", async () => {
    const { client, bodies } = cassetteClient("createThread_minimal_success");
    await client.createThread("agent-123", { title: "t" });
    expect(bodies).toEqual([{ agentId: "agent-123", title: "t" }]);
  });
});
