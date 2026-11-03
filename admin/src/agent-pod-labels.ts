/** Optional labels for agent pod templates; identity selectors stay platform-owned. */
const RESERVED = new Set([
  "app.kubernetes.io/name",
  "app.kubernetes.io/instance",
  "app.kubernetes.io/managed-by",
  "shipwright.dev/agent-id",
  "shipwright.dev/tenant",
]);
const NAME = /^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function validateAgentPodLabels(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SHIPWRIGHT_K8S_AGENT_POD_LABELS must be a JSON object");
  }
  for (const [key, label] of Object.entries(value)) {
    const parts = key.split("/");
    const name = parts.at(-1) ?? "";
    const prefix = parts.length === 2 ? parts[0] : undefined;
    if (
      parts.length > 2 ||
      name.length > 63 ||
      !NAME.test(name) ||
      (prefix !== undefined &&
        (prefix.length > 253 ||
          prefix
            .split(".")
            .some((part) => part.length > 63 || !DNS_LABEL.test(part)))) ||
      RESERVED.has(key)
    ) {
      throw new Error(
        `SHIPWRIGHT_K8S_AGENT_POD_LABELS has an invalid or reserved key: ${key}`,
      );
    }
    if (
      typeof label !== "string" ||
      label.length > 63 ||
      (label !== "" && !NAME.test(label))
    ) {
      throw new Error(
        `SHIPWRIGHT_K8S_AGENT_POD_LABELS has an invalid value for ${key}`,
      );
    }
  }
  return { ...value } as Record<string, string>;
}

export function parseAgentPodLabels(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return validateAgentPodLabels(JSON.parse(raw));
}
