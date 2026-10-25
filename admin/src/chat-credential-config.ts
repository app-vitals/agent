/**
 * admin/src/chat-credential-config.ts
 *
 * Pure parser for the chat-credential mint flag. Takes an injected env object
 * (no process.env reads) so it is deterministically unit-testable; admin-boot
 * reads it once at startup and injects the resolved config as deps. Same
 * "enabled" convention as the self-serve flag (self-serve-config.ts).
 */

/** Structural env shape — accepts `process.env` or a plain test object. */
type ChatCredentialEnv = Readonly<Record<string, string | undefined>>;

export interface ChatCredentialConfig {
  /** True only when SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED === "enabled". */
  enabled: boolean;
}

export function parseChatCredentialConfig(
  env: ChatCredentialEnv,
): ChatCredentialConfig {
  return { enabled: env.SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED === "enabled" };
}
