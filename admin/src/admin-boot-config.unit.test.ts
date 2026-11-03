import { describe, expect, it } from "bun:test";
import type { AgentTokenService } from "./agent-tokens.ts";
import { buildProvisioner, buildDeletionClients } from "./admin-boot-config.ts";
import {
  HttpChatServiceProvisioningClient,
  NoopChatServiceProvisioningClient,
} from "./chat-service-provisioning-client.ts";

describe("buildDeletionClients", () => {
  it("returns a no-op client when nothing is configured", () => {
    const { chatService } = buildDeletionClients({});
    expect(chatService).toBeInstanceOf(NoopChatServiceProvisioningClient);
  });

  it("needs both the URL and the admin token for the real client", () => {
    const { chatService } = buildDeletionClients({
      SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN: "chat-admin",
    });
    expect(chatService).toBeInstanceOf(NoopChatServiceProvisioningClient);
  });

  it("builds the real client when fully configured, independent of K8s provisioning", () => {
    const { chatService } = buildDeletionClients({
      SHIPWRIGHT_CHAT_SERVICE_URL: "http://chat.test",
      SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN: "chat-admin",
    });
    expect(chatService).toBeInstanceOf(HttpChatServiceProvisioningClient);
  });
});

describe("buildProvisioner pod label configuration", () => {
  it("rejects invalid labels during admin boot when provisioning is enabled", () => {
    expect(() =>
      buildProvisioner(
        {
          SHIPWRIGHT_K8S_PROVISIONING: "enabled",
          SHIPWRIGHT_K8S_AGENT_POD_LABELS: '{"app.kubernetes.io/name":"wrong"}',
        },
        {} as AgentTokenService,
      ),
    ).toThrow("reserved key");
  });
});
