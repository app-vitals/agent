/**
 * lib/redact.ts
 * Secret redaction for cron-run transcripts (COS-43.1). Lives in lib/ so the
 * runtime (which redacts before upload) and admin can both import it.
 *
 * Two passes, both returning the redacted text plus how many substitutions
 * were made:
 *   - redactValues: the live values of SECRET_ENV_VARS (the same scrub the
 *     Sentry hooks use, lib/sentry.ts redactSecrets).
 *   - redactShapes: well-known credential shapes (GitHub/Anthropic/OpenAI/
 *     Slack/AWS tokens, PEM private keys, bearer tokens, JWTs).
 */

import { liveSecretValues, redactSecrets } from "./sentry.ts";

export interface RedactResult {
  text: string;
  count: number;
}

type Env = Readonly<Record<string, string | undefined>>;

export const REDACTED = "[REDACTED]";

const SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // Not preceded by an alphanumeric, so "task-<slug>" is not an OpenAI key.
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /Bearer [A-Za-z0-9._-]{16,}/g,
];

/** Replaces the live values of SECRET_ENV_VARS in `env` (default process.env). */
export function redactValues(
  text: string,
  env: Env = process.env,
): RedactResult {
  const secrets = liveSecretValues(env);
  let count = 0;
  for (const secret of secrets) {
    count += text.split(secret).length - 1;
  }
  if (count === 0) return { text, count: 0 };
  return { text: redactSecrets(text, secrets, new WeakSet(), 0), count };
}

/** Replaces well-known credential shapes. */
export function redactShapes(text: string): RedactResult {
  let count = 0;
  let out = text;
  for (const re of SHAPES) {
    out = out.replace(re, () => {
      count++;
      return REDACTED;
    });
  }
  return { text: out, count };
}

/** redactValues then redactShapes; counts are summed. */
export function redact(text: string, env: Env = process.env): RedactResult {
  const values = redactValues(text, env);
  const shapes = redactShapes(values.text);
  return { text: shapes.text, count: values.count + shapes.count };
}
