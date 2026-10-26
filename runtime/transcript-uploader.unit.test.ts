/**
 * runtime/transcript-uploader.unit.test.ts
 * COS-43.1: path resolution + fallback, truncation marker, feature off,
 * redaction before upload, errors swallowed. All deps injected.
 */

import { describe, expect, it } from "bun:test";
import {
  createTranscriptUploader,
  MAX_TRANSCRIPT_BYTES,
  type TranscriptFs,
} from "./transcript-uploader.ts";

const HOME = "/data/agent-home";
const CWD = "/data/agent-home/workspace";
const ENCODED = "-data-agent-home-workspace";
const SESSION = "sess-123";
const PRIMARY = `${HOME}/dot-claude/projects/${ENCODED}/${SESSION}.jsonl`;

function memFs(files: Record<string, string>): TranscriptFs {
  return {
    async readFile(path) {
      const f = files[path];
      if (f === undefined) throw new Error(`ENOENT ${path}`);
      return f;
    },
    async readdir(path) {
      const prefix = `${path}/`;
      return [
        ...new Set(
          Object.keys(files)
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length).split("/")[0] as string),
        ),
      ];
    },
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function setup(
  files: Record<string, string>,
  opts: {
    features?: { transcriptUpload: boolean } | undefined;
    status?: number;
    throwFetch?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const features =
    "features" in opts ? opts.features : { transcriptUpload: true };
  const uploader = createTranscriptUploader({
    fs: memFs(files),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (opts.throwFetch) throw new Error("network down");
      return new Response("{}", { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
    clock: { now: () => new Date("2026-10-26T00:00:00Z") },
    env: {
      AGENT_HOME: HOME,
      SHIPWRIGHT_AGENT_API_KEY: "agent-key-xyz",
      ...opts.env,
    },
    log: (l) => logs.push(l),
    apiUrl: "https://admin.example",
    agentId: "agent-1",
    getFeatures: () => features,
  });
  const run = (sessionId: string | null = SESSION) =>
    uploader.upload({
      cronId: "cron-1",
      runId: "run-1",
      sessionId: sessionId ?? undefined,
      cwd: CWD,
    });
  return { calls, logs, run };
}

describe("transcript uploader", () => {
  it("PUTs the redacted transcript to the run's transcript path", async () => {
    const { calls, run } = setup({ [PRIMARY]: '{"a":1}\n{"b":2}\n' });
    await run();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://admin.example/agents/agent-1/crons/cron-1/runs/run-1/transcript",
    );
    const init = calls[0]?.init as RequestInit;
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer agent-key-xyz",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: SESSION,
      body: '{"a":1}\n{"b":2}\n',
      truncated: false,
      redactions: 0,
    });
  });

  it("falls back to projects/*/<sessionId>.jsonl when the encoded cwd misses", async () => {
    const other = `${HOME}/dot-claude/projects/-somewhere-else/${SESSION}.jsonl`;
    const { calls, run } = setup({
      [other]: "fallback\n",
      [`${HOME}/dot-claude/projects/-x/other.jsonl`]: "nope\n",
    });
    await run();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.init.body as string).body).toBe("fallback\n");
  });

  it("encodes both / and . in the cwd", async () => {
    const dotted = "/data/agent.home/work";
    const p = `${HOME}/dot-claude/projects/-data-agent-home-work/${SESSION}.jsonl`;
    const calls: string[] = [];
    const up = createTranscriptUploader({
      fs: memFs({ [p]: "ok\n" }),
      fetch: (async (_u: string, init: RequestInit) => {
        calls.push(init.body as string);
        return new Response("{}");
      }) as unknown as typeof fetch,
      clock: { now: () => new Date() },
      env: { AGENT_HOME: HOME, SHIPWRIGHT_AGENT_API_KEY: "k" },
      log: () => {},
      apiUrl: "https://a",
      agentId: "a1",
      getFeatures: () => ({ transcriptUpload: true }),
    });
    await up.upload({
      cronId: "c",
      runId: "r",
      sessionId: SESSION,
      cwd: dotted,
    });
    expect(calls).toHaveLength(1);
  });

  it("redacts secrets and reports the count", async () => {
    const tok = `ghp_${"A1b2C3d4E5".repeat(3)}`;
    const { calls, run } = setup({ [PRIMARY]: `line ${tok}\n` });
    await run();
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.body).not.toContain(tok);
    expect(body.redactions).toBe(1);
  });

  it("tail-truncates to 1 MiB keeping whole lines with a marker first", async () => {
    const line = `${JSON.stringify({ pad: "x".repeat(1000) })}\n`;
    const count = Math.ceil((MAX_TRANSCRIPT_BYTES * 1.5) / line.length);
    const lines = Array.from({ length: count }, (_, i) =>
      JSON.stringify({ i, pad: "x".repeat(1000) }),
    );
    const { calls, run } = setup({ [PRIMARY]: `${lines.join("\n")}\n` });
    await run();
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.body)).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_BYTES,
    );
    const out = (body.body as string).split("\n").filter(Boolean);
    expect(JSON.parse(out[0] as string).type).toBe("transcript-truncated");
    // The kept tail is whole lines ending at the final input line.
    expect(JSON.parse(out[out.length - 1] as string).i).toBe(count - 1);
    for (const l of out) JSON.parse(l);
  });

  it("does nothing when the feature is off, absent, or sessionId unknown", async () => {
    for (const features of [{ transcriptUpload: false }, undefined]) {
      const { calls, run } = setup({ [PRIMARY]: "x\n" }, { features });
      await run();
      expect(calls).toHaveLength(0);
    }
    const { calls, run } = setup({ [PRIMARY]: "x\n" });
    await run(null);
    expect(calls).toHaveLength(0);
  });

  it("does nothing without an API key", async () => {
    const { calls, run } = setup(
      { [PRIMARY]: "x\n" },
      { env: { SHIPWRIGHT_AGENT_API_KEY: "" } },
    );
    await run();
    expect(calls).toHaveLength(0);
  });

  it("swallows a missing file, a fetch failure and a non-2xx with one log line each", async () => {
    const missing = setup({});
    await missing.run();
    expect(missing.logs).toHaveLength(1);
    expect(missing.calls).toHaveLength(0);

    const thrown = setup({ [PRIMARY]: "x\n" }, { throwFetch: true });
    await thrown.run();
    expect(thrown.logs).toHaveLength(1);

    const bad = setup({ [PRIMARY]: "x\n" }, { status: 500 });
    await bad.run();
    expect(bad.logs).toHaveLength(1);
    expect(bad.logs[0]).toContain("500");
  });

  it("never logs the transcript body", async () => {
    const { logs, run } = setup(
      { [PRIMARY]: "TOP-SECRET-BODY\n" },
      { status: 500 },
    );
    await run();
    expect(logs.join("\n")).not.toContain("TOP-SECRET-BODY");
  });
});
