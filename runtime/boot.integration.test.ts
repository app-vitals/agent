/**
 * agent/src/runtime/boot.integration.test.ts
 *
 * Integration tests for the startup sequence in boot.ts (startAgent).
 * startAgent has no dependency-injection seam: it reads process.env, patches
 * console, binds a health server, registers signal handlers and starts
 * intervals. So each test boots it in a real child `bun` process (isolated
 * HOME/AGENT_HOME in a temp dir) against a local fake admin API, then asserts
 * on the requests the fake saw, the boot log order and the exit behaviour.
 * Isolation contract: no mock.module(), no global overrides in this process.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const AGENT_ID = "boot-test-agent";
const API_KEY = "boot-test-key";
const BOOT_TIMEOUT_MS = 30_000;

const BUNDLE = {
  specialty: "coding",
  env: { BOOT_TEST_SYNCED_VAR: "synced" },
  allowedTools: ["Read", "Bash"],
  plugins: [],
  repos: [],
  reviewAuthorAllowlist: [],
  patchAuthorAllowlist: [],
  restrictSlackToMembers: false,
  memberEmails: [],
  autoPostReviews: true,
  allowSelfReview: false,
  minConfidence: 75,
  maxFindings: 5,
  cleanupMergedWorktrees: true,
  cleanupAfterDays: 14,
};

type Route = (req: Request) => Response | Promise<Response>;

interface FakeAdmin {
  url: string;
  /** "METHOD /path" in arrival order. */
  requests: string[];
  authHeaders: string[];
  stop(): void;
}

function startFakeAdmin(overrides: Record<string, Route> = {}): FakeAdmin {
  const requests: string[] = [];
  const authHeaders: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const routes: Record<string, Route> = {
    [`GET /agents/${AGENT_ID}/config`]: () => json(BUNDLE),
    [`GET /agents/${AGENT_ID}/crons`]: () => json([]),
    [`POST /agents/${AGENT_ID}/template/reconcile`]: () => json({}),
    [`POST /agents/${AGENT_ID}/crons/reconcile`]: () => json({}),
    ...overrides,
  };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const key = `${req.method} ${new URL(req.url).pathname}`;
      requests.push(key);
      authHeaders.push(req.headers.get("authorization") ?? "");
      const route = routes[key];
      return route ? route(req) : json({ error: "not found" }, 404);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    authHeaders,
    stop: () => void server.stop(true),
  };
}

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

// ─── Child process harness ─────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = `/tmp/test-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(tmpRoot, "home"), { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

interface Booted {
  proc: ReturnType<typeof Bun.spawn>;
  healthPort: number;
  /** Combined stdout+stderr captured so far. */
  output(): string;
  /** Resolves once `needle` appears in the output; rejects on early exit/timeout. */
  waitFor(needle: string): Promise<void>;
  exited: Promise<number>;
}

function bootAgent(env: Record<string, string>): Booted {
  // The driver is the equivalent of the repo's index.ts, plus one extension
  // that records onConfigSync calls so we can see the extension seam fire.
  const driver = join(tmpRoot, "driver.ts");
  const bootPath = join(import.meta.dir, "boot.ts");
  writeFileSync(
    driver,
    `import { appendFileSync } from "node:fs";
import { startAgent } from ${JSON.stringify(bootPath)};
await startAgent([
  () => ({
    onConfigSync: (bundle: { specialty: string }) =>
      appendFileSync(${JSON.stringify(join(tmpRoot, "ext.log"))}, "onConfigSync:" + bundle.specialty + "\\n"),
  }),
]);
`,
  );

  const healthPort = freePort();
  const cleanEnv: Record<string, string> = {};
  for (const k of ["PATH", "TMPDIR", "LANG"]) {
    const v = process.env[k];
    if (v) cleanEnv[k] = v;
  }
  const proc = Bun.spawn(["bun", driver], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...cleanEnv,
      HOME: join(tmpRoot, "home"),
      AGENT_HOME: join(tmpRoot, "agent-home"),
      SHIPWRIGHT_HEALTH_PORT: String(healthPort),
      SHIPWRIGHT_PR_STATE_RECONCILER_INTERVAL_MS: "3600000",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let buf = "";
  const waiters: Array<{ needle: string; resolve: () => void }> = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buf += decoder.decode(chunk);
      for (const w of [...waiters]) {
        if (buf.includes(w.needle)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  const exited = proc.exited as Promise<number>;
  return {
    proc,
    healthPort,
    output: () => buf,
    exited,
    waitFor: (needle) =>
      new Promise<void>((resolve, reject) => {
        if (buf.includes(needle)) return resolve();
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for "${needle}"\n${buf}`)),
          BOOT_TIMEOUT_MS - 2_000,
        );
        waiters.push({
          needle,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
        void exited.then((code) =>
          reject(new Error(`exited ${code} before "${needle}"\n${buf}`)),
        );
      }),
  };
}

/** Index of `needle` in the boot output; fails the test if absent. */
function at(output: string, needle: string): number {
  const i = output.indexOf(needle);
  expect(i, `missing "${needle}" in:\n${output}`).toBeGreaterThanOrEqual(0);
  return i;
}

async function shutdownAndWait(
  b: Booted,
  signal: "SIGTERM" | "SIGINT" = "SIGTERM",
) {
  b.proc.kill(signal);
  return await b.exited;
}

async function waitForRequest(admin: FakeAdmin, request: string) {
  const deadline = Date.now() + 10_000;
  while (!admin.requests.includes(request) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}

const adminEnv = (admin: FakeAdmin): Record<string, string> => ({
  SHIPWRIGHT_API_URL: admin.url,
  SHIPWRIGHT_AGENT_API_KEY: API_KEY,
  SHIPWRIGHT_AGENT_ID: AGENT_ID,
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("startAgent — startup sequencing (admin wired)", () => {
  it(
    "runs the boot steps in documented order and serves /health",
    async () => {
      const admin = startFakeAdmin();
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[agent] cron sync started");
        const out = b.output();

        // Step 1 -> 2 -> 3 -> 4 -> 5 -> 5b -> 6
        const order = [
          "[agent] agent home initialized",
          "[agent] health server on port",
          "[agent] mise startup complete",
          "[agent] default plugin install complete",
          "[agent] config sync started (60s interval)",
          "[agent] agent template reconciled",
          "[agent] system crons reconciled",
          "[agent] PR state reconciler started",
          "[agent] cron sync started (60s interval)",
        ].map((n) => at(out, n));
        expect(order).toEqual([...order].sort((x, y) => x - y));

        // Health server is already bound while the agent runs.
        const res = await fetch(`http://127.0.0.1:${b.healthPort}/health`);
        expect(res.status).toBe(200);
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "calls the admin API in order, authenticated, and fires the extension hook after the config fetch",
    async () => {
      const admin = startFakeAdmin();
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[agent] cron sync started");
        const [cfg, tmpl, sys] = [
          `GET /agents/${AGENT_ID}/config`,
          `POST /agents/${AGENT_ID}/template/reconcile`,
          `POST /agents/${AGENT_ID}/crons/reconcile`,
        ].map((r) => admin.requests.indexOf(r));
        expect(cfg).toBeGreaterThanOrEqual(0);
        expect(tmpl).toBeGreaterThan(cfg);
        expect(sys).toBeGreaterThan(tmpl);
        // Cron sync is last (Step 6) and fire-and-forget.
        await waitForRequest(admin, `GET /agents/${AGENT_ID}/crons`);
        expect(admin.requests).toContain(`GET /agents/${AGENT_ID}/crons`);
        expect(
          admin.requests.indexOf(`GET /agents/${AGENT_ID}/crons`),
        ).toBeGreaterThan(sys);
        expect(admin.authHeaders.every((h) => h === `Bearer ${API_KEY}`)).toBe(
          true,
        );

        const ext = readFileSync(join(tmpRoot, "ext.log"), "utf8");
        expect(ext).toBe("onConfigSync:coding\n");
        // The bundle env was applied before boot finished.
        expect(b.output()).toContain(
          "[config-sync] updated: BOOT_TEST_SYNCED_VAR",
        );
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "starts the chat poll loop only when both chat service vars are set",
    async () => {
      const admin = startFakeAdmin();
      const b = bootAgent({
        ...adminEnv(admin),
        SHIPWRIGHT_CHAT_SERVICE_URL: "http://127.0.0.1:1",
        SHIPWRIGHT_CHAT_SERVICE_TOKEN: "chat-token",
        SHIPWRIGHT_CHAT_POLL_INTERVAL_MS: "3600000",
      });
      try {
        await b.waitFor("[agent] chat poll loop started (3600000ms interval)");
        const out = b.output();
        expect(at(out, "[agent] cron sync started")).toBeLessThan(
          at(out, "[agent] chat poll loop started"),
        );
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );
});

describe("startAgent — failure paths are non-fatal", () => {
  it(
    "keeps booting when the config bundle fetch returns 404, and still reconciles",
    async () => {
      const admin = startFakeAdmin({
        [`GET /agents/${AGENT_ID}/config`]: () =>
          new Response(JSON.stringify({ error: "nope" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      });
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[agent] cron sync started");
        const out = b.output();
        expect(out).toContain("[config-sync] no config bundle found");
        expect(out).toContain("[agent] config sync started (60s interval)");
        expect(out).toContain("[agent] agent template reconciled");
        // The extension hook is never reached when the fetch fails.
        expect(existsSync(join(tmpRoot, "ext.log"))).toBe(false);
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "keeps booting when the config bundle fetch returns 500",
    async () => {
      const admin = startFakeAdmin({
        [`GET /agents/${AGENT_ID}/config`]: () =>
          new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      });
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[agent] cron sync started");
        const out = b.output();
        expect(out).toContain("[config-sync] failed to fetch config bundle:");
        expect(out).toContain("failed: 500");
        expect(out).toContain("[agent] config sync started (60s interval)");
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "a reconcileTemplate failure is logged non-fatally and reconcileSystemCrons still runs",
    async () => {
      const admin = startFakeAdmin({
        [`POST /agents/${AGENT_ID}/template/reconcile`]: () =>
          new Response("{}", { status: 500 }),
      });
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[agent] cron sync started");
        const out = b.output();
        expect(out).toContain("[agent] reconcileTemplate failed (non-fatal):");
        expect(out).not.toContain("[agent] agent template reconciled");
        expect(out).toContain("[agent] system crons reconciled");
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "a reconcileSystemCrons failure is logged non-fatally and the cron sync loop still starts",
    async () => {
      const admin = startFakeAdmin({
        [`POST /agents/${AGENT_ID}/crons/reconcile`]: () =>
          new Response("{}", { status: 500 }),
      });
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[agent] cron sync started");
        const out = b.output();
        expect(out).toContain(
          "[agent] reconcileSystemCrons failed (non-fatal):",
        );
        expect(out).toContain("[agent] agent template reconciled");
        expect(out).not.toContain("[agent] system crons reconciled");
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "logs a cron-list failure without crashing the process",
    async () => {
      const admin = startFakeAdmin({
        [`GET /agents/${AGENT_ID}/crons`]: () =>
          new Response("{}", { status: 500 }),
      });
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[cron-sync] failed to fetch cron jobs:");
        const health = await fetch(`http://127.0.0.1:${b.healthPort}/health`);
        expect(health.status).toBe(200);
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );
});

describe("startAgent — offline / unwired boot", () => {
  it(
    "without admin credentials skips config sync, reconcile and cron sync, and runs Slack-less",
    async () => {
      const b = bootAgent({});
      try {
        await b.waitFor("[agent] Slack credentials absent");
        const out = b.output();
        expect(out).toContain("[agent] default plugin install complete");
        expect(out).not.toContain("config sync started");
        expect(out).not.toContain("reconciled");
        expect(out).not.toContain("cron sync started");
        expect(out).not.toContain("PR state reconciler started");
        expect(out).toContain("Offline mode");
        expect(at(out, "[agent] default plugin install complete")).toBeLessThan(
          at(out, "[agent] Slack credentials absent"),
        );
        const res = await fetch(`http://127.0.0.1:${b.healthPort}/health`);
        expect(res.status).toBe(200);
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "initialises the agent home directory before anything else",
    async () => {
      const b = bootAgent({});
      try {
        await b.waitFor("[agent] health server on port");
        expect(existsSync(join(tmpRoot, "agent-home"))).toBe(true);
        expect(existsSync(join(tmpRoot, "agent-home", "workspace"))).toBe(true);
      } finally {
        b.proc.kill("SIGKILL");
        await b.exited;
      }
    },
    BOOT_TIMEOUT_MS,
  );
});

describe("startAgent — graceful shutdown (Step 8)", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(
      `exits 0 after logging the ordered shutdown sequence on ${signal}`,
      async () => {
        const b = bootAgent({});
        await b.waitFor("[agent] Slack credentials absent");
        const code = await shutdownAndWait(b, signal);
        expect(code).toBe(0);
        const out = b.output();
        expect(
          at(out, `received ${signal}, beginning graceful shutdown`),
        ).toBeLessThan(at(out, "[agent] shutdown complete"));
        // Offline mode: no Slack app to stop.
        expect(out).not.toContain("[agent] Slack app stopped");
      },
      BOOT_TIMEOUT_MS,
    );
  }

  it(
    "unschedules cron tasks on shutdown when jobs were scheduled",
    async () => {
      const admin = startFakeAdmin({
        [`GET /agents/${AGENT_ID}/crons`]: () =>
          new Response(
            JSON.stringify([
              {
                id: "job-1",
                name: "nightly",
                enabled: true,
                parentCronId: null,
                schedule: "0 3 * * *",
                prompt: "hello",
                channel: null,
                user: null,
                silent: false,
                preCheck: null,
              },
            ]),
            { headers: { "Content-Type": "application/json" } },
          ),
      });
      const b = bootAgent(adminEnv(admin));
      try {
        await b.waitFor("[agent] cron sync started");
        // syncCrons is fire-and-forget; wait until it has hit the API.
        await waitForRequest(admin, `GET /agents/${AGENT_ID}/crons`);
        await Bun.sleep(300);
        const code = await shutdownAndWait(b);
        expect(code).toBe(0);
        expect(b.output()).toContain(
          "[agent] cron unscheduled on shutdown: job-1",
        );
      } finally {
        admin.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
