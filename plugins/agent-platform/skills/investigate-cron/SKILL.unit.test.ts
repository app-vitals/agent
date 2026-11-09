import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const content = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");

/** Extract fenced code blocks of the given language from the markdown. */
function blocks(lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g");
  for (const m of content.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

function run(cmd: string[], input?: string, env?: Record<string, string>) {
  const p = Bun.spawnSync(cmd, {
    stdin: input === undefined ? undefined : new TextEncoder().encode(input),
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

const hasBin = (b: string) => Bun.which(b) !== null;

describe("SKILL.md — code blocks are well-formed", () => {
  it("every bash block parses with bash -n", () => {
    const bash = blocks("bash");
    expect(bash.length).toBeGreaterThan(5);
    for (const b of bash) {
      // Skip blocks containing template placeholders like <RUN_STARTED_AT ...>.
      if (/<[A-Za-z_ ]+[^>\n]*>/.test(b)) continue;
      const r = run(["bash", "-n"], b);
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    }
  });

  it("the python extraction script compiles", () => {
    if (!hasBin("python3")) return;
    const py = blocks("python").find((b) => b.includes("INITIAL PROMPT"));
    expect(py).toBeDefined();
    const r = run(["python3", "-I", "-c", `compile(${JSON.stringify(py)}, "x", "exec")`]);
    expect(r.code).toBe(0);
  });

  it("the python extraction script reports the narrative from a sample transcript", () => {
    if (!hasBin("python3")) return;
    const py = blocks("python").find((b) => b.includes("INITIAL PROMPT")) ?? "";
    const lines = [
      { type: "user", message: { content: "[Cron job: abc] hello" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "checked, nothing to do [silent]" },
            { type: "tool_use", name: "Bash", input: { command: "ls", description: "list" } },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const dir = mkdtempSync("/tmp/ic-unit-");
    const jsonl = join(dir, "s.jsonl");
    const script = join(dir, "x.py");
    writeFileSync(jsonl, lines);
    writeFileSync(script, py);
    const r = run(["python3", "-I", script, jsonl]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[Cron job: abc] hello");
    expect(r.out).toContain("BASH COMMANDS (1 total)");
    expect(r.out).toContain("SILENT: True");
  });
});

describe("SKILL.md — closest-run selection (jq)", () => {
  it("picks the run whose startedAt is nearest the target", () => {
    if (!hasBin("jq")) return;
    const m = content.match(/BEST_RUN=\$\(jq -r --argjson target "\$TARGET_EPOCH" '([\s\S]*?)' "\$RUNS_FILE"\)/);
    expect(m).not.toBeNull();
    const program = m?.[1] ?? "";
    const runs = [
      { id: "far", startedAt: "2026-01-01T00:00:00.000Z" },
      { id: "near", startedAt: "2026-01-01T18:02:00.123Z" },
      { id: "mid", startedAt: "2026-01-01T12:00:00.000Z" },
    ];
    const target = Date.parse("2026-01-01T18:00:00Z") / 1000;
    const r = run(["jq", "-r", "--argjson", "target", String(target), program], JSON.stringify(runs));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).id).toBe("near");
  });
});

describe("SKILL.md — cron lookup (jq)", () => {
  const crons = [
    { id: "p1", name: "loop", parentCronId: null },
    { id: "c1", name: "review", parentCronId: "p1" },
    { id: "s1", name: "nightly", parentCronId: null },
  ];
  const lookup = `[.[] | select(.name == $n or .id == $n)] | first // empty`;

  it("resolves a named phase cron to its parent", () => {
    if (!hasBin("jq")) return;
    const r = run(["jq", "-c", "--arg", "n", "review", lookup], JSON.stringify(crons));
    expect(JSON.parse(r.out)).toMatchObject({ id: "c1", parentCronId: "p1" });
  });

  it("resolves a top-level cron with no parent", () => {
    if (!hasBin("jq")) return;
    const r = run(["jq", "-c", "--arg", "n", "nightly", lookup], JSON.stringify(crons));
    expect(JSON.parse(r.out).parentCronId).toBeNull();
  });

  it("returns nothing for an unknown name", () => {
    if (!hasBin("jq")) return;
    const r = run(["jq", "-c", "--arg", "n", "nope", lookup], JSON.stringify(crons));
    expect(r.out.trim()).toBe("");
  });

  it("the skill's lookup expression matches the one under test", () => {
    expect(content).toContain(lookup);
  });
});

describe("SKILL.md — Sentry gate", () => {
  const gate = `echo "org_set=$([ -n "$SENTRY_ORG" ] && echo yes || echo no) token_set=$([ -n "$SENTRY_AUTH_TOKEN" ] && echo yes || echo no)"`;

  it("reports both as unset when env is empty", () => {
    const r = run(["bash", "-c", gate]);
    expect(r.out.trim()).toBe("org_set=no token_set=no");
  });

  it("reports only the token missing when just SENTRY_ORG is set", () => {
    const r = run(["bash", "-c", gate], undefined, { SENTRY_ORG: "o" });
    expect(r.out.trim()).toBe("org_set=yes token_set=no");
  });

  it("never echoes the values themselves", () => {
    const r = run(["bash", "-c", gate], undefined, { SENTRY_ORG: "secret-org", SENTRY_AUTH_TOKEN: "secret-tok" });
    expect(r.out).not.toContain("secret");
  });

  it("the skill documents the same gate and skip-notice", () => {
    expect(content).toContain(`echo "org_set=$([ -n "$SENTRY_ORG" ] && echo yes || echo no)`);
    expect(content).toContain("requires SENTRY_ORG and SENTRY_AUTH_TOKEN to be set");
  });
});

describe("SKILL.md — endpoints exist in this repo's admin API", () => {
  it("cites only routes registered by admin/", () => {
    const admin = readFileSync(join(import.meta.dir, "../../../../admin/src/agents-api.ts"), "utf-8");
    const api = readFileSync(join(import.meta.dir, "../../../../admin/src/api.ts"), "utf-8");
    expect(api).toContain('path: "/:id/crons"');
    expect(admin).toContain('path: "/agents/{id}/crons/{cronId}/runs"');
    expect(admin).toContain("itemId");
    expect(admin).toContain("phaseId");
  });

  it("every SHIPWRIGHT_* env var cited is read by runtime/config.ts", () => {
    const cfg = readFileSync(join(import.meta.dir, "../../../../runtime/config.ts"), "utf-8");
    const cited = new Set(content.match(/SHIPWRIGHT_[A-Z_]+/g) ?? []);
    expect(cited.size).toBeGreaterThan(0);
    for (const v of cited) expect(cfg).toContain(`"${v}"`);
  });
});

describe("SKILL.md — no shipwright-only endpoints in executable blocks", () => {
  it("bash blocks contain no /prs, /tasks, task-store or work-queue calls", () => {
    for (const b of blocks("bash")) {
      expect(b).not.toMatch(/\/prs\b|\/tasks\b|task-store|work-queue|gh pr view/i);
    }
  });
});
