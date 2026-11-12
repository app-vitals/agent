/**
 * admin/src/github-installation.fixtures.ts
 * Shared fakes for the installation repos / lost-access removal wiring tests.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import type { OpenWorkPort } from "./open-work-port.ts";

export const accessFor = (pushable: string[]): GithubAccessPreviewFn => {
  return async () => ({
    status: "ok",
    access: {
      username: "dev",
      outcome: "ok",
      userVerified: true,
      complete: true,
      unresolved: 0,
      checkedAt: "2026-11-11T00:00:00.000Z",
      orgs: [
        {
          org: "acme",
          status: "ok",
          unresolved: 0,
          repos: pushable.map((fullName) => ({
            fullName,
            level: "write" as const,
            canPush: true,
          })),
        },
      ],
    },
  });
};

export function fakePrisma(repos: string[]) {
  const state = { repos: [...repos], audits: 0 };
  const prisma = {
    agent: {
      findUnique: async () => ({
        id: "a1",
        repos: state.repos,
        githubUsername: "dev",
      }),
      update: async (args: { data: { repos: string[] } }) => {
        state.repos = args.data.repos;
      },
    },
    gitHubReconcileAudit: {
      create: async () => {
        state.audits += 1;
        return { id: "audit-1" };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, state };
}

export function fakeOpenWork() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const port: OpenWorkPort = {
    listOpenWork: async (...args) => {
      calls.push({ fn: "list", args });
      return [{ id: "T-1", repo: "acme/old", title: "fix it" }];
    },
    blockOpenWork: async (...args) => {
      calls.push({ fn: "block", args });
    },
  };
  return { port, calls };
}

export const envWith = (env?: Record<string, string>) => ({
  getConfigBundle: async (agentId: string) =>
    env ? { env, agentId, allowedTools: [] } : null,
});
