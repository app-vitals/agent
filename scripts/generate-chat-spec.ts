/**
 * scripts/generate-chat-spec.ts
 *
 * CLI entry point: regenerates chat/openapi.json from the chat route schemas.
 *
 * Usage:
 *   bun run generate:chat-spec
 */

import { generateChatSpec } from "../chat/src/generate-spec.ts";

generateChatSpec();
