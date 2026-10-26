/**
 * runtime/transcript-uploader.ts
 * Uploads a redacted copy of a cron run's Claude session transcript to the
 * admin API (COS-43.1) once the run is recorded.
 *
 * Gated by the synced config bundle's `features.transcriptUpload` (the admin
 * flag SHIPWRIGHT_TRANSCRIPT_API_ENABLED). Redaction happens HERE, before the
 * transcript leaves the pod: live SECRET_ENV_VARS values plus well-known token
 * shapes (lib/redact.ts). The body is tail-truncated to 1 MiB on whole lines
 * with a marker line first. Every failure logs one line (never the body) and
 * is swallowed — an upload problem must never fail or alter a run.
 *
 * All I/O is injected ({ fs, fetch, clock, env, log }) so it is unit-testable.
 */

import { join } from "node:path";
import { redact } from "@app-vitals/agent-lib/redact";
import type { Clock } from "./clock.ts";

/** Upload cap; the admin route 413s above it. */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

/** Bytes reserved for the truncation marker line. */
const MARKER_RESERVE = 256;

export interface TranscriptFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

export interface TranscriptFeatures {
  transcriptUpload?: boolean;
}

export interface TranscriptUploaderDeps {
  fs: TranscriptFs;
  fetch: typeof fetch;
  clock: Clock;
  env: Readonly<Record<string, string | undefined>>;
  /** One-line logger; never receives transcript content. */
  log: (line: string) => void;
  apiUrl: string;
  agentId: string;
  /** The last synced `features` from the config bundle (absent before sync). */
  getFeatures: () => TranscriptFeatures | undefined;
}

export interface TranscriptUploadArgs {
  cronId: string;
  runId: string;
  sessionId: string | undefined;
  /** The cwd the run's Claude process was spawned in. */
  cwd: string;
}

export interface TranscriptUploader {
  upload(args: TranscriptUploadArgs): Promise<void>;
}

/** Claude Code's project-dir naming: every "/" and "." becomes "-". */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

async function readTranscript(
  deps: TranscriptUploaderDeps,
  cwd: string,
  sessionId: string,
): Promise<string> {
  const home = deps.env.AGENT_HOME ?? "";
  const projects = join(home, "dot-claude", "projects");
  const primary = join(projects, encodeCwd(cwd), `${sessionId}.jsonl`);
  try {
    return await deps.fs.readFile(primary);
  } catch {
    // Fall back to scanning every project dir for the session file.
  }
  for (const dir of await deps.fs.readdir(projects)) {
    try {
      return await deps.fs.readFile(join(projects, dir, `${sessionId}.jsonl`));
    } catch {
      // not in this project dir
    }
  }
  throw new Error("transcript file not found");
}

/** Keeps whole trailing lines within the cap, prefixed by a marker line. */
function tailTruncate(text: string): { body: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_TRANSCRIPT_BYTES) {
    return { body: text, truncated: false };
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const budget = MAX_TRANSCRIPT_BYTES - MARKER_RESERVE;
  let used = 0;
  let keepFrom = lines.length;
  while (keepFrom > 0) {
    const size = Buffer.byteLength(lines[keepFrom - 1] as string) + 1;
    if (used + size > budget) break;
    used += size;
    keepFrom--;
  }
  const marker = JSON.stringify({
    type: "transcript-truncated",
    note: "earlier lines dropped to fit the 1 MiB transcript cap",
    droppedLines: keepFrom,
    keptLines: lines.length - keepFrom,
  });
  const kept = lines.slice(keepFrom);
  return {
    body: `${marker}\n${kept.length ? `${kept.join("\n")}\n` : ""}`,
    truncated: true,
  };
}

export function createTranscriptUploader(
  deps: TranscriptUploaderDeps,
): TranscriptUploader {
  return {
    async upload({ cronId, runId, sessionId, cwd }) {
      if (deps.getFeatures()?.transcriptUpload !== true) return;
      if (!sessionId) return;
      const apiKey = deps.env.SHIPWRIGHT_AGENT_API_KEY;
      if (!apiKey) return;
      const started = deps.clock.now().getTime();
      try {
        const raw = await readTranscript(deps, cwd, sessionId);
        const { text, count } = redact(raw, deps.env);
        const { body, truncated } = tailTruncate(text);
        const url = `${deps.apiUrl}/agents/${deps.agentId}/crons/${cronId}/runs/${runId}/transcript`;
        const res = await deps.fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            sessionId,
            body,
            truncated,
            redactions: count,
          }),
        });
        if (!res.ok) {
          deps.log(
            `[transcript-upload] run ${runId} upload returned ${res.status} — skipped`,
          );
        }
      } catch (err) {
        const ms = deps.clock.now().getTime() - started;
        deps.log(
          `[transcript-upload] run ${runId} failed after ${ms}ms: ${err instanceof Error ? err.message : String(err)} — skipped`,
        );
      }
    },
  };
}
