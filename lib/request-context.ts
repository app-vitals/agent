/**
 * Represents an authenticated request caller, shared across services that
 * resolve caller identity in auth middleware (admin, task-store, metrics).
 *
 * scope === "*" → unrestricted/admin (all clients/agents)
 * scope === "<id>" → scoped to a single identity (clientId, agentId, etc.)
 */
export interface Caller {
  name: string;
  scope: string; // "*" or a scoped identity such as a clientId/agentId
}

/**
 * Produce a stable, readable label for a caller, suitable for log lines.
 * Returns "anonymous" when no caller is present (e.g. unauthenticated or
 * not-yet-resolved requests). When the auth middleware's scope kind is
 * known, it is appended in brackets (e.g. "svc (platform.read) [platform-read]").
 */
export function callerLabel(caller?: Caller, scopeKind?: string): string {
  if (!caller) return "anonymous";
  const label = `${caller.name} (${caller.scope})`;
  return scopeKind ? `${label} [${scopeKind}]` : label;
}
