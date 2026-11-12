import { describe, expect, it } from "bun:test";
import {
  accessFor,
  envWith,
  fakeOpenWork,
  fakePrisma,
} from "./github-installation.fixtures.ts";
import {
  createGithubInstallationRepos,
  createGithubSync,
} from "./github-installation-wiring.ts";
import type { InstallationReposPort } from "./installation-repos-service.ts";

const noApp = { get: async () => null, getPrivateKey: async () => null };

const portWith = (
  seen: number[],
  repos: string[] = ["acme/old", "acme/api"],
): InstallationReposPort => ({
  listRepos: async (appId) => {
    seen.push(appId);
    return { acme: repos };
  },
  listInstalled: async (appId) => {
    seen.push(appId);
    return { status: "found", orgs: [{ org: "acme", repos }] };
  },
  addRepos: async () => {},
  removeRepos: async () => {},
});

describe("createGithubInstallationRepos", () => {
  it("lists from the agent's own stored GH_APP_ID", async () => {
    const seen: number[] = [];
    const { prisma } = fakePrisma(["acme/old"]);
    const svc = createGithubInstallationRepos({
      prisma,
      appService: noApp,
      access: accessFor(["acme/api"]),
      agentEnv: envWith({ GH_APP_ID: " 77 " }),
      installationRepos: portWith(seen),
    });
    const res = await svc.list("a1");
    expect(seen).toEqual([77]);
    expect(res.status).toBe("ok");
  });

  it("reports an agent with no GH_APP_ID, naming the missing var", async () => {
    const { prisma } = fakePrisma(["acme/old"]);
    const envs: (Record<string, string> | undefined)[] = [
      undefined,
      { OTHER: "x" },
      { GH_APP_ID: "abc" },
    ];
    for (const env of envs) {
      const svc = createGithubInstallationRepos({
        prisma,
        appService: noApp,
        access: accessFor([]),
        agentEnv: envWith(env),
        installationRepos: portWith([]),
      });
      const res = await svc.list("a1");
      expect(res.status).toBe("no_app_id");
      if (res.status === "no_app_id") expect(res.reason).toContain("GH_APP_ID");
    }
  });
});

describe("createGithubSync", () => {
  const build = (openWork?: ReturnType<typeof fakeOpenWork>["port"]) => {
    const { prisma, state } = fakePrisma(["acme/old", "acme/api"]);
    const svc = createGithubSync({
      prisma,
      appService: noApp,
      access: accessFor(["acme/api"]),
      agentEnv: envWith({ GH_APP_ID: "42" }),
      installationRepos: portWith([]),
      openWork,
    });
    return { svc, state };
  };

  it("with a port: preview lists affected open work and apply blocks it", async () => {
    const { port, calls } = fakeOpenWork();
    const { svc, state } = build(port);
    const preview = await svc.preview("a1");
    expect(preview.status).toBe("previewed");
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      appAdds: [],
      appRemoves: ["acme/old"],
      agentRemoves: ["acme/old"],
    });
    expect(res.status).toBe("applied");
    expect(state.repos).toEqual(["acme/api"]);
    const block = calls.find((c) => c.fn === "block");
    expect(block?.args[0]).toBe("a1");
    expect(block?.args[1]).toEqual(["acme/old"]);
  });

  it("without a port: nothing is blocked, apply still works", async () => {
    const { svc, state } = build();
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      appAdds: [],
      appRemoves: [],
      agentRemoves: ["acme/old"],
    });
    expect(res.status).toBe("applied");
    expect(state.repos).toEqual(["acme/api"]);
  });
});
