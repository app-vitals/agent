import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChatDockerRunArgs,
  buildDockerRunArgs,
  buildProbeScript,
  checkAgentLibCopies,
  deriveEntries,
  evaluateBoot,
  evaluateChatBoot,
  findEmptyWildcards,
  findUnreachableModules,
  parseArgs,
  RESOLUTION_ERROR,
} from "./consumer-smoke.ts";

function fixture(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "consumer-smoke-unit-"));
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

describe("deriveEntries", () => {
  test("non-wildcard modules are imported, the root entry maps to the bare name", () => {
    const entries = deriveEntries(
      "@app-vitals/x",
      { ".": "./src/server.ts", "./boot": "./boot.ts" },
      "/nonexistent",
    );
    expect(entries).toEqual([
      { specifier: "@app-vitals/x", mode: "import" },
      { specifier: "@app-vitals/x/boot", mode: "import" },
    ]);
  });

  test("json, package.json and prisma.config are resolved, not imported", () => {
    const entries = deriveEntries(
      "@app-vitals/x",
      {
        "./theme-tokens.json": "./src/theme-tokens.json",
        "./package.json": "./package.json",
        "./prisma.config": "./prisma.config.ts",
      },
      "/nonexistent",
    );
    expect(entries.map((e) => e.mode)).toEqual([
      "resolve",
      "resolve",
      "resolve",
    ]);
  });

  test("wildcards expand by globbing the source dir and skip tests", () => {
    const dir = fixture([
      "src/coding/a.ts",
      "src/coding/b.ts",
      "src/coding/a.unit.test.ts",
      "prisma/schema/schema.prisma",
      "prisma/migrations/001/migration.sql",
    ]);
    try {
      const entries = deriveEntries(
        "@app-vitals/x",
        {
          "./coding/*": "./src/coding/*.ts",
          "./prisma/schema/*": "./prisma/schema/*",
          "./prisma/migrations/*": "./prisma/migrations/*",
        },
        dir,
      );
      expect(entries).toEqual([
        { specifier: "@app-vitals/x/coding/a", mode: "import" },
        { specifier: "@app-vitals/x/coding/b", mode: "import" },
        {
          specifier: "@app-vitals/x/prisma/schema/schema.prisma",
          mode: "resolve",
        },
        {
          specifier: "@app-vitals/x/prisma/migrations/001/migration.sql",
          mode: "resolve",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wildcard matching nothing yields no entries", () => {
    const dir = fixture(["other.txt"]);
    try {
      expect(deriveEntries("@a/b", { "./c/*": "./src/c/*.ts" }, dir)).toEqual(
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildProbeScript", () => {
  test("embeds every specifier and its mode", () => {
    const script = buildProbeScript([
      { specifier: "@a/b/c", mode: "import" },
      { specifier: "@a/b/d.json", mode: "resolve" },
    ]);
    expect(script).toContain('"@a/b/c"');
    expect(script).toContain('"@a/b/d.json"');
    expect(script).toContain("process.exit(1)");
  });
});

describe("buildDockerRunArgs", () => {
  test("agent bypasses the env-checking entrypoint and runs index.ts", () => {
    const args = buildDockerRunArgs("agent", "agent:ci", "n", "/fx");
    expect(args.slice(args.indexOf("--entrypoint"))).toEqual([
      "--entrypoint",
      "bun",
      "agent:ci",
      "run",
      "index.ts",
    ]);
    expect(args).toContain("AGENT_HOME=/tmp/agent-home");
    expect(args).toContain("/fx:/fixture-specialties:ro");
    expect(args).toContain("SHIPWRIGHT_DEFAULT_AGENT_TYPE=fixture");
  });

  test("admin keeps its image entrypoint", () => {
    const args = buildDockerRunArgs("admin", "admin:ci", "n", "/fx");
    expect(args).not.toContain("--entrypoint");
    expect(args.join(" ")).not.toContain("SPECIALTIES");
    expect(args.at(-1)).toBe("admin:ci");
  });
});

describe("evaluateBoot", () => {
  test("passes when the readiness marker is logged", () => {
    expect(
      evaluateBoot("agent", {
        logs: "x [agent] agent home initialized: /h",
        exitCode: null,
      }).ok,
    ).toBe(true);
  });

  test("passes when admin reaches startAdmin then fails fast on missing config", () => {
    const r = evaluateBoot("admin", {
      logs: "[admin] starting admin service on port 3000\n[admin] fatal startup error: x",
      exitCode: 1,
    });
    expect(r.ok).toBe(true);
  });

  test("fails on module resolution errors even when the marker is present", () => {
    const logs =
      "[agent] agent home initialized\nerror: Cannot find module '@app-vitals/agent-lib/http'";
    expect(RESOLUTION_ERROR.test(logs)).toBe(true);
    expect(evaluateBoot("agent", { logs, exitCode: 1 }).ok).toBe(false);
  });

  test("fails when the agent entrypoint exits on missing env before the marker", () => {
    const r = evaluateBoot("agent", {
      logs: "[entrypoint] SHIPWRIGHT_AGENT_ID is required",
      exitCode: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exit 1");
  });

  test("fails when the marker is never logged", () => {
    expect(evaluateBoot("admin", { logs: "boom", exitCode: 1 }).ok).toBe(false);
  });
});

describe("parseArgs", () => {
  test("flags win over env; version is required", () => {
    const a = parseArgs(["--version", "1.2.3", "--dir", "/tmp/x"], {
      CONSUMER_SMOKE_VERSION: "9.9.9",
    });
    expect(a.version).toBe("1.2.3");
    expect(a.dir).toBe("/tmp/x");
    expect(parseArgs([], { CONSUMER_SMOKE_VERSION: "2.0.0" }).version).toBe(
      "2.0.0",
    );
    expect(() => parseArgs([], {})).toThrow(/version/);
  });

  test("tarball mode skips boot by default; a leading v is stripped", () => {
    const a = parseArgs(["--version", "v1.0.0", "--tarballs", "/t"], {});
    expect(a.version).toBe("1.0.0");
    expect(a.tarballs).toBe("/t");
    expect(a.boot).toBe(false);
    expect(parseArgs(["--version", "1.0.0"], {}).boot).toBe(true);
  });
});

describe("parseArgs --no-admin-boot", () => {
  test("defaults to booting admin and can be disabled", () => {
    expect(parseArgs(["--version", "1.0.0"], {}).bootAdmin).toBe(true);
    expect(
      parseArgs(["--version", "1.0.0", "--no-admin-boot"], {}).bootAdmin,
    ).toBe(false);
    expect(parseArgs(["--version", "1.0.0"], {}).importProbe).toBe(true);
    expect(
      parseArgs(["--version", "1.0.0", "--no-import-probe"], {}).importProbe,
    ).toBe(false);
  });
});

describe("checkAgentLibCopies", () => {
  const top = { path: "node_modules/@app-vitals/agent-lib/package.json", version: "0.1.2" };
  const nested = {
    path: "node_modules/@app-vitals/agent-admin/node_modules/@app-vitals/agent-lib/package.json",
    version: "0.1.0",
  };

  test("passes a single copy at VERSION", () => {
    expect(checkAgentLibCopies([top], "0.1.2")).toEqual([]);
  });

  test("fails a nested second copy and a copy not at VERSION", () => {
    const out = checkAgentLibCopies([nested, top], "0.1.2");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("is 0.1.0, expected 0.1.2");
    expect(out[1]).toContain("found 2");
  });

  test("fails when no copy is installed", () => {
    expect(checkAgentLibCopies([], "0.1.2")[0]).toContain("found 0");
  });
});

describe("findUnreachableModules", () => {
  const files = ["src/server.ts", "src/agents.ts", "src/agents.unit.test.ts"];

  test("fails for a shipped module no export reaches (the 0.1.2 gap)", () => {
    const out = findUnreachableModules({ ".": "./src/server.ts" }, files);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("src/agents.ts");
  });

  test("a wildcard export reaches every module; test files are ignored", () => {
    expect(
      findUnreachableModules(
        { ".": "./src/server.ts", "./*": "./src/*.ts" },
        files,
      ),
    ).toEqual([]);
  });

  test("an allowlisted private module is not reported", () => {
    expect(
      findUnreachableModules(
        { ".": "./src/server.ts" },
        files,
        new Set(["src/agents.ts"]),
      ),
    ).toEqual([]);
  });
});

describe("findEmptyWildcards", () => {
  test("fails when a wildcard expands to zero files (dangling ./coding/*)", () => {
    const dir = fixture(["src/a.ts"]);
    try {
      const out = findEmptyWildcards(
        { "./*": "./src/*.ts", "./coding/*": "./src/coding/*.ts" },
        dir,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain("./coding/*");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a wildcard that matches only test files counts as empty", () => {
    const dir = fixture(["src/a.unit.test.ts"]);
    try {
      expect(findEmptyWildcards({ "./*": "./src/*.ts" }, dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  const GENERATED = { "./prisma/client/*": "./prisma/client/*" };

  test("a generated-path wildcard with no checkout files passes when the installed package has them", () => {
    const checkout = fixture(["src/a.ts"]);
    const installed = fixture(["prisma/client/index.js"]);
    try {
      expect(findEmptyWildcards(GENERATED, checkout, installed)).toEqual([]);
    } finally {
      rmSync(checkout, { recursive: true });
      rmSync(installed, { recursive: true });
    }
  });

  test("a generated-path wildcard still fails when the installed package lacks the files", () => {
    const checkout = fixture(["src/a.ts"]);
    const installed = fixture(["src/a.ts"]);
    try {
      expect(findEmptyWildcards(GENERATED, checkout, installed)).toHaveLength(1);
    } finally {
      rmSync(checkout, { recursive: true });
      rmSync(installed, { recursive: true });
    }
  });

  test("an empty source wildcard still fails even when an installed dir is given", () => {
    const checkout = fixture(["src/a.ts"]);
    const installed = fixture(["src/coding/x.ts", "prisma/client/index.js"]);
    try {
      const out = findEmptyWildcards(
        { ...GENERATED, "./coding/*": "./src/coding/*.ts" },
        checkout,
        installed,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain("./coding/*");
    } finally {
      rmSync(checkout, { recursive: true });
      rmSync(installed, { recursive: true });
    }
  });
});

describe("chat boot check", () => {
  test("buildChatDockerRunArgs points the image at the throwaway Postgres on its network", () => {
    const args = buildChatDockerRunArgs("chat:ci", "n", "net", "pg");
    expect(args.slice(0, 3)).toEqual(["docker", "run", "-d"]);
    expect(args).toContain("net");
    expect(args).toContain(
      "DATABASE_URL_SHIPWRIGHT_CHAT=postgres://postgres:smoke@pg:5432/chat",
    );
    expect(args.at(-1)).toBe("chat:ci");
  });

  test("evaluateChatBoot passes only when migrated and /health says ok", () => {
    const logs = "[chat] running prisma migrate deploy...\n[chat] migrations complete";
    expect(
      evaluateChatBoot({ logs, healthBody: '{"status":"ok","service":"chat"}' })
        .ok,
    ).toBe(true);
  });

  test("evaluateChatBoot fails on resolution errors, missing migrations, no health or a bad body", () => {
    const logs = "[chat] migrations complete";
    expect(
      evaluateChatBoot({ logs: "error: Cannot find module 'x'", healthBody: "{}" }).ok,
    ).toBe(false);
    expect(evaluateChatBoot({ logs: "[chat] starting", healthBody: '{"status":"ok"}' }).ok).toBe(false);
    expect(evaluateChatBoot({ logs, healthBody: null }).ok).toBe(false);
    expect(evaluateChatBoot({ logs, healthBody: '{"status":"down"}' }).ok).toBe(false);
    expect(evaluateChatBoot({ logs, healthBody: "not json" }).ok).toBe(false);
  });

  test("parseArgs derives the chat image and honours --no-chat-boot", () => {
    const a = parseArgs(["--version", "1.2.3"], {});
    expect(a.chatImage).toBe("ghcr.io/app-vitals/agent-chat:1.2.3");
    expect(a.bootChat).toBe(true);
    expect(parseArgs(["--version", "1.2.3", "--no-chat-boot"], {}).bootChat).toBe(false);
    expect(parseArgs(["--version", "1.2.3", "--no-agent-boot"], {}).bootAgent).toBe(false);
  });
});
