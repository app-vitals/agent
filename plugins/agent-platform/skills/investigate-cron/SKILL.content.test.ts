import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH) ? readFileSync(SKILL_MD_PATH, "utf-8") : "";
});

describe("SKILL.md — file and frontmatter", () => {
  it("exists and has content", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
    expect(content.length).toBeGreaterThan(200);
  });

  it("has name: investigate-cron and a description", () => {
    expect(content).toContain("name: investigate-cron");
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — modes", () => {
  it("documents name+time mode", () => {
    expect(content).toContain("investigate-cron <name> <time>");
    expect(content).toContain('MODE="name-time"');
  });

  it("documents --item mode with an optional --cron filter", () => {
    expect(content).toContain("--item");
    expect(content).toContain('MODE="item"');
    expect(content).toContain("--cron");
  });

  it("defaults the timezone to Pacific", () => {
    expect(content).toContain("Pacific");
    expect(content).toContain("America/Los_Angeles");
  });
});

describe("SKILL.md — admin API run lookup (generic)", () => {
  it("uses the platform env vars verified against runtime/config.ts", () => {
    expect(content).toContain("$SHIPWRIGHT_API_URL");
    expect(content).toContain("$SHIPWRIGHT_AGENT_API_KEY");
    expect(content).toContain("$SHIPWRIGHT_AGENT_ID");
  });

  it("lists crons via GET /agents/{id}/crons and runs via /crons/{id}/runs", () => {
    expect(content).toContain("/agents/$SHIPWRIGHT_AGENT_ID/crons");
    expect(content).toMatch(/\/crons\/\$\w+\/runs/);
  });

  it("looks the cron up by name and handles optional parent/phase crons", () => {
    expect(content).toContain(".name == $n");
    expect(content).toContain("parentCronId");
    expect(content).toContain("phaseId");
  });

  it("passes itemId through as a server-side filter", () => {
    expect(content).toContain("itemId");
    expect(content).toContain("server-side");
  });

  it("paginates with limit and offset", () => {
    expect(content).toContain("limit=100");
    expect(content).toContain("offset");
  });

  it("ranks the closest run to the target time client-side", () => {
    expect(content).toContain("TARGET_EPOCH");
    expect(content).toContain("distance");
  });
});

describe("SKILL.md — transcript extraction", () => {
  it("resolves the transcript directly from the run's sessionId", () => {
    expect(content).toContain("sessionId");
    expect(content).toContain("$TRANSCRIPT_DIR/$SESSION_ID.jsonl");
  });

  it("derives the transcript dir from the CWD with / and . replaced by -", () => {
    expect(content).toContain("~/.claude/projects/");
    expect(content).toContain("tr '/.' '-'");
    expect(content).toContain("-data-agent-home-workspace");
  });

  it("falls back to an mtime window when sessionId is null", () => {
    expect(content).toContain("mtime-window fallback");
    expect(content).toContain("[Cron job:");
    expect(content).toContain("+/-90 minute");
  });

  it("extracts prompt, assistant text, Bash commands and [silent]", () => {
    expect(content).toContain("INITIAL PROMPT");
    expect(content).toContain("BASH COMMANDS");
    expect(content).toContain("[silent]");
  });
});

describe("SKILL.md — Sentry cross-check", () => {
  it("is gated on SENTRY_ORG and SENTRY_AUTH_TOKEN", () => {
    expect(content).toContain("SENTRY_ORG");
    expect(content).toContain("SENTRY_AUTH_TOKEN");
  });

  it("skips cleanly with a notice and never blocks the investigation", () => {
    expect(content).toContain("Skipping this step");
    expect(content).toContain("Never block the rest of the investigation");
  });

  it("never prints the token or org values", () => {
    expect(content).toContain("Never print, log, or persist the literal values");
  });

  it("queries issues and the ourlogs dataset", () => {
    expect(content).toContain("is:unresolved");
    expect(content).toContain("dataset=ourlogs");
  });
});

describe("SKILL.md — synthesis", () => {
  it("separates verified claims from inferences", () => {
    expect(content).toContain("[verified:");
    expect(content).toContain("[inferred]");
  });

  it("defines both output formats", () => {
    expect(content).toContain("Cron: <name>");
    expect(content).toContain("Dispatch history");
  });
});

describe("SKILL.md — no-match handler", () => {
  it("points at runtime/cron-handler.ts, not the stale agent/src path", () => {
    expect(content).toContain("runtime/cron-handler.ts");
    expect(content).not.toContain("agent/src/cron-handler.ts");
    expect(content).toContain("[agent:cron]");
  });

  it("reports when no dispatch history exists", () => {
    expect(content).toContain("No session found for cron");
    expect(content).toContain("No dispatch history found");
  });
});

describe("SKILL.md — no shipwright-only surfaces", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["/prs endpoint", /\/prs\b/],
    ["/tasks endpoint", /\/tasks\b/],
    ["task-store", /task[- ]store/i],
    ["TASK_STORE env vars", /TASK_STORE/],
    ["work-queue", /work[- ]queue/i],
    ["shipwright-loop", /shipwright-loop/],
    ["loop cron", /loop cron/i],
    ["gh pr view / GitHub live diff", /gh pr view/],
    ["/shipwright: command namespace", /\/shipwright:/],
  ];
  for (const [label, re] of forbidden) {
    it(`does not reference ${label}`, () => {
      expect(content).not.toMatch(re);
    });
  }
});
