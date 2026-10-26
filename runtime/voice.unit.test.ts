/**
 * agent/src/runtime/voice.unit.test.ts
 *
 * Documents and locks the contract between makeWhisperSvcClient and the
 * self-hosted Whisper pod the chart ships (onerahmet/openai-whisper-asr-webservice).
 *
 * That image exposes a single ASR endpoint:
 *   POST /asr?encode=true&task=transcribe&output=txt
 * with the audio attached as the multipart field `audio_file`, and (with
 * output=txt) returns the transcription as a plain-text body — NOT JSON.
 *
 * These tests use an injected fetchFn (no global.fetch mutation) per the
 * test-isolation contract.
 *
 * synthesizeSpeech dispatch coverage (ElevenLabs vs Piper, including the
 * fs-touching Piper success/failure paths) lives in voice.integration.test.ts
 * — this file is pure logic, no I/O of any kind, per docs/test-readiness/test-system.md.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  buildVoiceConfig,
  makeWhisperSvcClient,
  revertRemovedVoiceEnv,
} from "./voice.ts";

describe("makeWhisperSvcClient — onerahmet /asr contract", () => {
  test("POSTs to the /asr endpoint of the service URL", async () => {
    const fetchFn = mock(
      async (_url: string, _opts: RequestInit) =>
        new Response("hello world", { status: 200 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    await client(Buffer.from("audio"), "clip.webm");

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("http://whisper:9000/asr")).toBe(true);
  });

  test("includes the onerahmet query params (task=transcribe, output=txt, encode=true)", async () => {
    const fetchFn = mock(
      async (_url: string, _opts: RequestInit) =>
        new Response("ok", { status: 200 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    await client(Buffer.from("audio"), "clip.webm");

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    const qs = new URL(url).searchParams;
    expect(qs.get("task")).toBe("transcribe");
    expect(qs.get("output")).toBe("txt");
    expect(qs.get("encode")).toBe("true");
  });

  test("attaches the audio under the `audio_file` multipart field", async () => {
    const bodies: FormData[] = [];
    const fetchFn = mock(async (_url: string, opts: RequestInit) => {
      bodies.push(opts.body as FormData);
      return new Response("ok", { status: 200 });
    });
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    await client(Buffer.from("audio"), "/tmp/recording.webm");

    const form = bodies[0];
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("audio_file") as File | null;
    expect(file).not.toBeNull();
    expect(file?.name).toBe("recording.webm");
  });

  test("parses the plain-text (output=txt) body as the transcription", async () => {
    const fetchFn = mock(
      async (_url: string, _opts: RequestInit) =>
        new Response("  transcribed words  ", { status: 200 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    const result = await client(Buffer.from("audio"), "clip.webm");
    expect(result).toBe("transcribed words");
  });

  test("returns null on a non-2xx ASR response", async () => {
    const fetchFn = mock(async () => new Response("boom", { status: 500 }));
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );
    const warn = console.warn;
    console.warn = () => {};
    const result = await client(Buffer.from("audio"), "clip.webm");
    console.warn = warn;
    expect(result).toBeNull();
  });
});

describe("buildVoiceConfig — live env (COS-62.1)", () => {
  test("picks up ELEVENLABS_* set after an earlier build (env mutation)", () => {
    const env: Record<string, string | undefined> = {};
    expect(buildVoiceConfig(env).elevenLabsApiKey).toBeUndefined();

    env.ELEVENLABS_API_KEY = "xi-key";
    env.ELEVENLABS_VOICE_ID = "nPczCjzI2devNBz1zQrb";
    const cfg = buildVoiceConfig(env);
    expect(cfg.elevenLabsApiKey).toBe("xi-key");
    expect(cfg.voiceId).toBe("nPczCjzI2devNBz1zQrb");
  });

  test("falls back to unset once the key is removed or empty", () => {
    const env: Record<string, string | undefined> = { ELEVENLABS_API_KEY: "k" };
    delete env.ELEVENLABS_API_KEY;
    expect(buildVoiceConfig(env).elevenLabsApiKey).toBeUndefined();
    env.ELEVENLABS_API_KEY = "";
    expect(buildVoiceConfig(env).elevenLabsApiKey).toBeUndefined();
  });
});

describe("revertRemovedVoiceEnv", () => {
  test("deletes a removed per-agent key with no pod baseline", () => {
    const proc: Record<string, string | undefined> = {
      ELEVENLABS_API_KEY: "k",
      ELEVENLABS_VOICE_ID: "v",
    };
    const reverted = revertRemovedVoiceEnv(
      new Set(["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]),
      {},
      {},
      proc,
    );
    expect(reverted.sort()).toEqual([
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_VOICE_ID",
    ]);
    expect(proc.ELEVENLABS_API_KEY).toBeUndefined();
  });

  test("restores the fleet/pod value when the per-agent override is removed", () => {
    const proc: Record<string, string | undefined> = {
      ELEVENLABS_API_KEY: "agent",
    };
    revertRemovedVoiceEnv(
      new Set(["ELEVENLABS_API_KEY"]),
      {},
      { ELEVENLABS_API_KEY: "fleet" },
      proc,
    );
    expect(proc.ELEVENLABS_API_KEY).toBe("fleet");
  });

  test("leaves keys alone that are still in the bundle or never came from it", () => {
    const proc: Record<string, string | undefined> = {
      ELEVENLABS_API_KEY: "a",
      GROQ_API_KEY: "pod",
    };
    const reverted = revertRemovedVoiceEnv(
      new Set(["ELEVENLABS_API_KEY"]),
      { ELEVENLABS_API_KEY: "a" },
      {},
      proc,
    );
    expect(reverted).toEqual([]);
    expect(proc.GROQ_API_KEY).toBe("pod");
  });
});
