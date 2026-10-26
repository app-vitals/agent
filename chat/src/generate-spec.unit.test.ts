/**
 * chat/src/generate-spec.unit.test.ts
 * Verify the chat OpenAPI spec generator produces a valid
 * OpenAPI 3.1 document that covers all three route groups.
 *
 * Uses buildChatSpec() in memory; one test reads the committed openapi.json.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChatSpec } from "./generate-spec.ts";

describe("buildChatSpec", () => {
  it("returns a valid OpenAPI 3.1 document", () => {
    const spec = buildChatSpec() as Record<string, unknown>;
    expect(spec.openapi).toBe("3.1.0");
  });

  it("includes /tokens paths", () => {
    const spec = buildChatSpec() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const tokenPaths = paths.filter((p) => p.startsWith("/tokens"));
    expect(tokenPaths.length).toBeGreaterThan(0);
  });

  it("includes /threads paths", () => {
    const spec = buildChatSpec() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const threadPaths = paths.filter((p) => p.startsWith("/threads"));
    expect(threadPaths.length).toBeGreaterThan(0);
  });

  it("includes /threads/.../messages paths", () => {
    const spec = buildChatSpec() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const messagePaths = paths.filter(
      (p) => p.startsWith("/threads/") && p.includes("/messages"),
    );
    expect(messagePaths.length).toBeGreaterThan(0);
  });

  it("matches the committed chat/openapi.json (run `bun run generate:chat-spec` if stale)", () => {
    const committed = readFileSync(
      join(import.meta.dir, "../openapi.json"),
      "utf-8",
    );
    expect(committed).toBe(`${JSON.stringify(buildChatSpec(), null, 2)}\n`);
  });
});
