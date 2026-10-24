/**
 * docs/docs-links.content.test.ts
 *
 * Link-integrity test for the platform docs in this directory: every relative
 * markdown link must resolve to an existing file, and every `#anchor` into a
 * local .md file must match a heading slug there (GitHub slug rules).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DOCS = [
  "specialties.md",
  "specialties-examples.md",
  "specialties-sources.md",
  "github-multi-org.md",
  "agent-api.md",
  "agent-api-ops.md",
  "agent-api-resources.md",
  "anthropic-usage-by-agent.md",
  "self-serve.md",
];

/** Remove fenced code blocks so links inside examples are not checked. */
function stripFences(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

/** GitHub heading slug: lowercase, drop punctuation, spaces to hyphens. */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headingSlugs(markdown: string): Set<string> {
  const counts = new Map<string, number>();
  const slugs = new Set<string>();
  for (const line of stripFences(markdown).split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match?.[1]) continue;
    // Strip inline markdown formatting: links -> text, backticks/emphasis.
    const text = match[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*]/g, "");
    const base = slugify(text);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

function relativeLinks(markdown: string): string[] {
  const links: string[] = [];
  const text = stripFences(markdown).replace(/`[^`\n]*`/g, "");
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:
    links.push(target);
  }
  return links;
}

describe("docs relative links", () => {
  for (const doc of DOCS) {
    const docPath = join(import.meta.dir, doc);
    const markdown = readFileSync(docPath, "utf-8");

    it(`${doc} has only resolvable relative links and anchors`, () => {
      const problems: string[] = [];
      for (const link of relativeLinks(markdown)) {
        const hashAt = link.indexOf("#");
        const filePart = hashAt === -1 ? link : link.slice(0, hashAt);
        const anchor = hashAt === -1 ? "" : link.slice(hashAt + 1);

        const targetPath = filePart
          ? resolve(dirname(docPath), filePart)
          : docPath;
        if (!existsSync(targetPath)) {
          problems.push(`${link}: file not found`);
          continue;
        }
        if (anchor && targetPath.endsWith(".md")) {
          const slugs = headingSlugs(readFileSync(targetPath, "utf-8"));
          if (!slugs.has(anchor.toLowerCase())) {
            problems.push(`${link}: no heading with slug "${anchor}"`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
