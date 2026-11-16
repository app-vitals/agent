/**
 * admin/src/server.ts
 * Shipwright admin service — Hono entrypoint.
 *
 * Mounts:
 *   - Admin UI routes at /admin/* (server-rendered)
 *   - Admin CRUD API at /agents/:id/* (JSON)
 *   - Agent runtime API at /agents/* (JSON, internal)
 */

export { PrismaClient } from "../prisma/client/client.ts";
export type {
  AdminExtension,
  AdminExtensionContext,
  SettingsNavContribution,
} from "./admin-extension.ts";
export type { AdminUIDeps } from "./admin-ui.ts";
export { createAdminUIApp } from "./admin-ui.ts";
export type {
  RenderSettingsLayoutOptions,
  SettingsNav,
  SettingsNavItem,
  SettingsNavSection,
} from "./admin-ui-settings-layout.ts";
export {
  getSettingsNav,
  mergeSettingsNavItems,
  renderSettingsLayout,
} from "./admin-ui-settings-layout.ts";
export type {
  AgentCronJob,
  CreateAgentCronJobInput,
} from "./agent-cron-jobs.ts";
export { AgentCronJobService } from "./agent-cron-jobs.ts";
export type { AgentEnvBundle, AgentEnvEntry } from "./agent-envs.ts";
export { AgentEnvService } from "./agent-envs.ts";
export type { AgentPlugin as AgentPluginRecord } from "./agent-plugins.ts";
export { AgentPluginService } from "./agent-plugins.ts";
export type { AgentToken, AgentTokenValidated } from "./agent-tokens.ts";
export { AgentTokenService } from "./agent-tokens.ts";
export type { AgentTool } from "./agent-tools.ts";
export { AgentToolService } from "./agent-tools.ts";
export type { AdminDeps } from "./agents-api.ts";
export { createAdminApp } from "./agents-api.ts";
export type {
  AgentConfigResponse,
  AgentPlugin,
  AgentRuntimeDeps,
} from "./api.ts";
export { createAgentRuntimeApp } from "./api.ts";
export {
  ApiError,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.ts";
export type { GoogleAuthClient } from "./google-auth-client.ts";
export { HttpGoogleAuthClient } from "./google-auth-client.ts";
export { createAdminPrismaClient } from "./prisma-client.ts";
export type { SlackProvisioningClient } from "./slack-provisioning-client.ts";
export { HttpSlackProvisioningClient } from "./slack-provisioning-client.ts";
export type { TokenCrypto } from "./token-crypto.ts";
export { identityCrypto, makeTokenCrypto } from "./token-crypto.ts";
