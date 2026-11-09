/**
 * Base-image contract guard (ARD-2.1).
 *
 * Downstream images build FROM the shipwright-agent image and
 * COPY a marketplace to the /opt/shipwright/marketplaces/ convention root. This
 * test builds such a derived image the same way and asserts the contract:
 *   - a marketplace at the convention root registers at boot via installPlugins()
 *   - /app/runtime/entrypoint-main.ts exists and runs under `bun run`
 *   - /app/scripts/bin/gh, git and the git-credential helper are executable, ahead of the real ones on PATH
 *
 * Needs a Docker daemon and an already-built base image, so it is image-level
 * smoke and opt-in: set SHIPWRIGHT_CONTRACT_BASE_IMAGE (CI sets it to the image
 * built by the `agent docker build` job). Skipped otherwise.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_IMAGE = process.env.SHIPWRIGHT_CONTRACT_BASE_IMAGE;
const CONVENTION_ROOT = "/opt/shipwright/marketplaces";
const MARKETPLACE_NAME = "contract-test";
const DERIVED_TAG = `shipwright-agent-contract:${process.pid}`;

function docker(args: string[]) {
  const proc = Bun.spawnSync(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe.skipIf(!BASE_IMAGE)("agent base-image contract", () => {
  let contextDir: string;

  beforeAll(() => {
    contextDir = mkdtempSync(join(tmpdir(), "base-image-contract-"));
    const marketplaceDir = join(contextDir, "marketplace", ".claude-plugin");
    mkdirSync(marketplaceDir, { recursive: true });
    writeFileSync(
      join(marketplaceDir, "marketplace.json"),
      JSON.stringify({
        name: MARKETPLACE_NAME,
        owner: { name: "contract-test" },
        plugins: [],
      }),
    );
    writeFileSync(
      join(contextDir, "Dockerfile"),
      [
        `FROM ${BASE_IMAGE}`,
        "USER root",
        `COPY marketplace ${CONVENTION_ROOT}/${MARKETPLACE_NAME}/`,
        "USER 1000",
        "",
      ].join("\n"),
    );
    const build = docker(["build", "-t", DERIVED_TAG, contextDir]);
    expect(build.exitCode, build.stderr).toBe(0);
  }, 300_000);

  afterAll(() => {
    docker(["rmi", "-f", DERIVED_TAG]);
    if (contextDir) rmSync(contextDir, { recursive: true, force: true });
  });

  test("installPlugins() registers a marketplace baked at the convention root", () => {
    // Recording exec: asserts what installPlugins() asks `claude` to do without
    // needing network access or a logged-in CLI inside the container.
    const script = `
      import { installPlugins } from "/app/runtime/setup.ts";
      const calls = [];
      const exec = async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { stdout: "", exitCode: 0 };
      };
      await installPlugins(exec, "/tmp", [], undefined, "/nonexistent/installed_plugins.json");
      console.log("CALLS:" + JSON.stringify(calls));
    `;
    const run = docker([
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      DERIVED_TAG,
      "-e",
      script,
    ]);
    expect(run.exitCode, run.stderr).toBe(0);

    const line = run.stdout.split("\n").find((l) => l.startsWith("CALLS:"));
    expect(line, run.stdout).toBeDefined();
    const calls: string[][] = JSON.parse(
      (line as string).slice("CALLS:".length),
    );
    const adds = calls
      .filter(
        (c) => c.slice(0, 4).join(" ") === "claude plugin marketplace add",
      )
      .map((c) => c[4]);

    expect(adds).toContain(`${CONVENTION_ROOT}/${MARKETPLACE_NAME}`);
  }, 60_000);

  test("image bakes the app-vitals-agent marketplace and agent-platform plugin manifests", () => {
    const base = `${CONVENTION_ROOT}/app-vitals-agent`;
    const run = docker([
      "run",
      "--rm",
      "--entrypoint",
      "bash",
      DERIVED_TAG,
      "-c",
      `cat ${base}/.claude-plugin/marketplace.json && echo ::SPLIT:: && cat ${base}/agent-platform/.claude-plugin/plugin.json && test -f ${base}/agent-platform/scripts/slack-say.ts && test -f ${base}/agent-platform/skills/slack-say/SKILL.md`,
    ]);
    expect(run.exitCode, run.stderr).toBe(0);
    const [marketplaceJson, pluginJson] = run.stdout.split("::SPLIT::");
    const marketplace = JSON.parse(marketplaceJson as string);
    const plugin = JSON.parse(pluginJson as string);
    expect(marketplace.name).toBe("app-vitals-agent");
    expect(marketplace.plugins.map((p: { name: string }) => p.name)).toContain(
      plugin.name,
    );
  }, 60_000);

  test("entrypoint-main.ts exists and runs under `bun run`", () => {
    // No agent id/url/key: runEntrypoint() reports the missing vars and exits 1.
    // A missing file or broken import graph fails differently ("Module not
    // found"), so the message proves the entrypoint actually executed.
    const run = docker([
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      "-e",
      "SHIPWRIGHT_AGENT_ID=",
      "-e",
      "SHIPWRIGHT_API_URL=",
      "-e",
      "SHIPWRIGHT_AGENT_API_KEY=",
      DERIVED_TAG,
      "run",
      "/app/runtime/entrypoint-main.ts",
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout + run.stderr).toContain("SHIPWRIGHT_AGENT_ID");
  }, 60_000);

  test("scripts/bin holds executable gh, git and git-credential wrappers ahead of the real gh and git on PATH", () => {
    const run = docker([
      "run",
      "--rm",
      "--entrypoint",
      "bash",
      DERIVED_TAG,
      "-c",
      "test -x /app/scripts/bin/gh && test -x /app/scripts/bin/git && test -x /app/scripts/bin/git-credential-shipwright.sh && command -v gh git",
    ]);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout.trim().split("\n")).toEqual([
      "/app/scripts/bin/gh",
      "/app/scripts/bin/git",
    ]);
  }, 60_000);

  test("runtime image ships no devDependency-only packages and keeps the Prisma client", () => {
    const run = docker([
      "run",
      "--rm",
      "--entrypoint",
      "bash",
      DERIVED_TAG,
      "-c",
      'test -d /app/admin/prisma/client && test -z "$(find /app/node_modules/.bun -maxdepth 1 \\( -name "handlebars@*" -o -name "typescript@*" -o -name "@typescript+*" -o -name "semantic-release@*" -o -name "@biomejs+*" -o -name "npm@*" \\))"',
    ]);
    expect(run.exitCode, run.stdout + run.stderr).toBe(0);
  }, 60_000);
});

// Static guard (no Docker needed): the runtime stage must take node_modules
// from the production-only stage, never the build stage's full install.
describe("runtime Dockerfile", () => {
  const dockerfile = readFileSync(join(import.meta.dir, "Dockerfile"), "utf8");

  test("copies node_modules from the production-only stage", () => {
    expect(dockerfile).toMatch(
      /^COPY --from=prod-deps\b.*\/app\/node_modules \.\/node_modules$/m,
    );
    expect(dockerfile).not.toMatch(
      /^COPY --from=build\b.*\/app\/node_modules\b/m,
    );
    expect(dockerfile).toMatch(/^FROM base AS prod-deps$/m);
    expect(dockerfile).toMatch(/bun install --frozen-lockfile --production/);
  });
});
