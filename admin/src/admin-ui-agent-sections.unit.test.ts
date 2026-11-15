import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENT_POST_SECTIONS,
  AGENT_SECTIONS,
  agentSectionPath,
} from "./admin-ui-pages.ts";

const source = readFileSync(new URL("./admin-ui.ts", import.meta.url), "utf8");

interface Handler {
  route: string;
  suffix: string;
  body: string;
}

/** Every `app.<method>("/admin/agents/:id/...")` registration with its body. */
function agentHandlers(method: "post" | "get"): Handler[] {
  const re = /app\.(get|post)\(\s*"(\/admin\/agents\/:id(\/[^"]*)?)"/g;
  const hits = [...source.matchAll(re)];
  const all = [...source.matchAll(/\n {2}app\.(get|post|put|delete)\(/g)];
  return hits
    .filter((m) => m[1] === method)
    .map((m) => {
      const start = m.index ?? 0;
      const next = all.find((a) => (a.index ?? 0) > start);
      return {
        route: m[2] as string,
        suffix: (m[3] ?? "") as string,
        body: source.slice(start, next?.index ?? source.length),
      };
    });
}

describe("agent POST handler to section table (SGL-1.3)", () => {
  const posts = agentHandlers("post");

  test("scan finds the registered handlers", () => {
    expect(posts.length).toBeGreaterThan(25);
  });

  test("every POST /admin/agents/:id/* handler has a section entry", () => {
    const missing = posts
      .map((h) => h.suffix)
      .filter((s) => s !== "" && !(s in AGENT_POST_SECTIONS));
    expect(missing).toEqual([]);
  });

  test("the table has no stale entries", () => {
    const registered = new Set(posts.map((h) => h.suffix));
    const stale = Object.keys(AGENT_POST_SECTIONS).filter(
      (k) => !registered.has(k),
    );
    expect(stale).toEqual([]);
  });

  test("table values are real sections", () => {
    for (const s of Object.values(AGENT_POST_SECTIONS)) {
      expect(AGENT_SECTIONS).toContain(s);
    }
  });

  test("no handler redirects to a bare /admin/agents/:id path", () => {
    expect(source).not.toMatch(
      /`\/admin\/agents\/\$\{(agentId|result\.agentId)\}(\?|`)/,
    );
  });

  test("each handler's redirects use the section its card lives in", () => {
    const bad: string[] = [];
    for (const h of posts) {
      const expected = AGENT_POST_SECTIONS[h.suffix];
      if (!expected || h.suffix === "/settings") continue;
      for (const m of h.body.matchAll(
        /agentSectionPath\(\s*[\w.]+,\s*"(\w+)"/g,
      )) {
        if (m[1] !== expected) bad.push(`${h.suffix}: ${m[1]} != ${expected}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("error/success/warning params survive on every section", () => {
    for (const section of AGENT_SECTIONS) {
      const p = agentSectionPath("a1", section, {
        error: "bad thing",
        success: "ok",
      });
      const url = new URL(p, "http://x");
      expect(url.searchParams.get("error")).toBe("bad thing");
      expect(url.searchParams.get("success")).toBe("ok");
      expect(url.pathname).toBe(agentSectionPath("a1", section));
    }
  });
});
