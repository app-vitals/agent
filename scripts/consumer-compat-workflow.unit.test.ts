import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const raw = readFileSync(
  join(root, ".github/workflows/consumer-compat.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf = (Bun.YAML.parse(raw) as any) ?? {};
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
type Step = Record<string, any>;
// The header comment documents what is forbidden; assert on the YAML itself.
const code = raw
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");
const script = readFileSync(join(root, "scripts/consumer-compat.ts"), "utf8");
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
const scriptCode = stripComments(script);
const job = wf.jobs["consumer-compat"];
const steps: Step[] = job.steps;

describe("consumer compat workflow", () => {
  test("runs on pull_request, never pull_request_target, with read-only permissions", () => {
    expect(Object.keys(wf.on)).toContain("pull_request");
    expect(code).not.toContain("pull_request_target");
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
  });

  test("references no secrets and persists no credentials", () => {
    expect(code).not.toContain("secrets.");
    const checkouts = steps.filter((s) =>
      String(s.uses).startsWith("actions/checkout@"),
    );
    expect(checkouts).toHaveLength(2);
    for (const s of checkouts) {
      expect(s.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
      expect(s.with["persist-credentials"]).toBe(false);
      expect(s.with.token).toBeUndefined();
    }
  });

  test("checks out shipwright main by default and runs the compat script against it", () => {
    expect(job.env.SHIPWRIGHT_REPO).toContain("app-vitals/shipwright");
    expect(job.env.SHIPWRIGHT_REF).toContain("'main'");
    expect(job.env.DATABASE_URL_SHIPWRIGHT_ADMIN).toContain("localhost:5432");
    expect(job.services.postgres.image).toBe("postgres:18");
    const run = steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("bun install --frozen-lockfile");
    expect(run).toContain(
      "bun scripts/consumer-compat.ts --shipwright-dir ../shipwright",
    );
  });

  test("is required via the ruleset: not continue-on-error, and not a check the release waits on", () => {
    expect(code).not.toContain("continue-on-error");
    const release = readFileSync(
      join(root, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(release).not.toContain(job.name);
  });

  test("the guard is read-only toward shipwright: no push, gh, or credentials", () => {
    const forbidden = [
      /git\s+push/,
      /["'`\s]gh\s/,
      /["']gh["']/,
      /GH_TOKEN/,
      /GITHUB_TOKEN/,
      /secrets\./,
      /\btoken:/,
    ];
    for (const [label, src] of [
      ["scripts/consumer-compat.ts", scriptCode],
      ["consumer-compat.yml", code],
    ] as const)
      for (const re of forbidden)
        expect([label, re.test(src)]).toEqual([label, false]);
    expect(scriptCode).not.toContain('"push"');
    expect(scriptCode).not.toContain("git diff");
  });
});
