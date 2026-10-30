/**
 * SPECIALTY.md.template content regression guard — PCD-2.2
 *
 * The platform's SPECIALTY.md.template is the generic fallback for every agent
 * type, so it must stay a neutral stub. Specialty-specific pipeline content
 * (e.g. the coding specialty's Shipwright workflow) is shipped by the specialty
 * itself through its manifest's identity.templatesDir.
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The template sits beside this test, so this works in any repo layout.
const TEMPLATE_PATH = join(import.meta.dir, "SPECIALTY.md.template");

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

describe("SPECIALTY.md.template — generic stub", () => {
  it("is a non-empty stub", () => {
    expect(readTemplate().trim().length).toBeGreaterThan(0);
  });

  it.each([
    "shipwright",
    "dev-task",
    "dev-loop",
    "plan-session",
    "task-store",
    "TASK_STORE",
    "PullRequest",
    "explicit-target-only",
    "fifo",
    "curl",
  ])("does not mention Shipwright-pipeline term %p", (term) => {
    expect(readTemplate().toLowerCase()).not.toContain(term.toLowerCase());
  });
});
