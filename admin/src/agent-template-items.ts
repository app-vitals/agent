/**
 * admin/src/agent-template-items.ts
 * ATP-1.1: AgentTemplateItem kinds, row source markers, and the at-rest
 * encryption of template item payloads.
 *
 * An env item's payload is `{ value, secret? }`; `value` is encrypted with the
 * same TokenCrypto (AES-256-GCM, SHIPWRIGHT_ENCRYPTION_KEY) that AgentEnvService
 * uses for AgentEnv.value, so copying a template env onto an agent is a
 * decrypt-then-encrypt with one key. Other kinds hold no secrets and pass
 * through unchanged.
 */

import type { Prisma } from "../prisma/client/client.ts";
import { ANTHROPIC_CREDENTIAL_KEYS } from "./anthropic-credential-guard.ts";
import { UnprocessableEntityError } from "./errors.ts";
import type { TokenCrypto } from "./token-crypto.ts";

export const AGENT_TEMPLATE_ITEM_KINDS = [
  "env",
  "tool",
  "plugin",
  "cron",
] as const;
export type AgentTemplateItemKind = (typeof AGENT_TEMPLATE_ITEM_KINDS)[number];

/** `source` on AgentEnv / AgentTool / AgentPlugin / AgentCronJob. */
export const ROW_SOURCES = ["template", "custom"] as const;
export type RowSource = (typeof ROW_SOURCES)[number];

/** AgentTemplateItem.payload: a JSON object whose fields depend on `kind`. */
export type TemplateItemPayload = Prisma.InputJsonObject;

/** Returns the payload to store: an env item's `value` encrypted. */
export function sealTemplateItemPayload(
  kind: AgentTemplateItemKind,
  payload: TemplateItemPayload,
  crypto: TokenCrypto,
): TemplateItemPayload {
  if (kind !== "env") return payload;
  if (typeof payload.value !== "string") {
    throw new UnprocessableEntityError(
      "env template item payload needs a string value",
    );
  }
  return { ...payload, value: crypto.encrypt(payload.value) };
}

/** Reverses sealTemplateItemPayload(): an env item's `value` decrypted. */
export function openTemplateItemPayload(
  kind: AgentTemplateItemKind,
  payload: TemplateItemPayload,
  crypto: TokenCrypto,
): TemplateItemPayload {
  if (kind !== "env" || typeof payload.value !== "string") return payload;
  return { ...payload, value: crypto.decrypt(payload.value) };
}

/**
 * Env keys a template may never carry (ATP-1.3): per-agent credentials that
 * are minted for, or provisioned onto, one specific agent. Copying them from a
 * template would hand every agent the same identity.
 */
export const TEMPLATE_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_APP_ID",
  "SLACK_SIGNING_SECRET",
  "GH_TOKEN",
  "SHIPWRIGHT_AGENT_API_KEY",
  "SHIPWRIGHT_TASK_STORE_URL",
  "SHIPWRIGHT_TASK_STORE_TOKEN",
  ...ANTHROPIC_CREDENTIAL_KEYS,
]);

/** Throws UnprocessableEntityError (422) for a denylisted env key (case-insensitive). */
export function assertTemplateEnvKeyAllowed(key: string): void {
  if (TEMPLATE_ENV_DENYLIST.has(key.toUpperCase())) {
    throw new UnprocessableEntityError(
      `env key ${key} is a per-agent credential and cannot be set in a template`,
    );
  }
}
