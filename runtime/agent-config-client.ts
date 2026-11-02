/**
 * agent/src/runtime/agent-config-client.ts
 *
 * - AgentConfigClient — interface for DI (used by entrypoint and tests)
 * - RecordedAgentConfigClient — cassette-backed double for tests
 *
 * The HTTP implementation was consolidated into HttpShipwrightRuntimeClient
 * (shipwright-runtime-client.ts). Wire that via getAgentConfigBundle() as the
 * configClient adapter in entrypoint-main.ts.
 */

import type { AgentConfigResponse } from "@app-vitals/agent-admin";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface AgentConfigClient {
  getConfig(agentId: string): Promise<AgentConfigResponse>;
}

// ─── RecordedAgentConfigClient ───────────────────────────────────────────

/**
 * Cassette-backed client for tests.
 * Returns a fixed AgentConfigResponse on every call — no network required.
 */
export class RecordedAgentConfigClient implements AgentConfigClient {
  private readonly cassette: AgentConfigResponse;

  constructor(cassette: AgentConfigResponse) {
    this.cassette = cassette;
  }

  async getConfig(_agentId: string): Promise<AgentConfigResponse> {
    return this.cassette;
  }
}
