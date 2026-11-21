import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// admin-boot.ts holds the boot sequence and main.ts is the composition root
// that runs it. Calling startAdmin() would run migrations, open a DB pool and
// bind a socket, so both are asserted structurally against their source text
// (mirrors agent/src/index.boot-order.unit.test.ts).
const source = await Bun.file(join(import.meta.dir, "admin-boot.ts")).text();
const entrySource = await Bun.file(join(import.meta.dir, "main.ts")).text();

function position(marker: string): number {
  const at = source.indexOf(marker);
  expect(
    at,
    `boot marker missing from admin-boot.ts: ${marker}`,
  ).toBeGreaterThan(-1);
  return at;
}

function assertOrdered(markers: string[]): void {
  const positions = markers.map(position);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("admin-boot.ts boot sequence", () => {
  it("keeps the documented boot order: DB, services, routes, sweepers, serve, template seed, startup policy reconcile", () => {
    assertOrdered([
      'initSentry({ service: "admin" })',
      "await runMigrations();",
      "createAdminPrismaClient(",
      "makeTokenCrypto()",
      "new AgentService(prisma)",
      "const provisioner = buildProvisioner(",
      "const resolvedExtensions = resolveAdminExtensions(",
      'root.get("/health"',
      'root.route("/agents", runtimeApp)',
      'root.route("/", adminApiApp)',
      "createAccountsApp(",
      "mountRouteContributions(root, resolvedExtensions.apiRoutes)",
      'root.route("/", adminUIApp)',
      "mountRouteContributions(root, resolvedExtensions.adminUiRoutes)",
      "new TrialExpiryWarningSweeper(",
      "new TrialExpirySweeper(",
      "new AccountTrialWarningSweeper(",
      "new AccountTrialExpirySweeper(",
      "new GithubRepoRefresher(",
      "startBackgroundPasses(resolvedExtensions.backgroundPasses)",
      "const server = Bun.serve(",
      "const shutdown = registerGracefulShutdown(",
      "void runTemplateSeed(",
      "void runStartupPolicyReconcile(",
    ]);
  });

  it("registers the GitHub repo refresher on its own interval, with env-driven config (GLC-1.4)", () => {
    assertOrdered([
      "resolveRefreshConfig(process.env)",
      "new GithubRepoRefresher(",
      "createStoredAppRefreshDiscovery(",
      "[github-repo-refresher] tick error:",
      "githubRefreshConfig.intervalMs",
    ]);
  });

  it("applies the template seed after migrations, through the template service, without blocking serving (TMK-3.2)", () => {
    assertOrdered([
      "await runMigrations();",
      "const templateService = new AgentTemplateService(",
      "const server = Bun.serve(",
      "void runTemplateSeed(",
    ]);
    expect(source).toContain("raw: process.env.SHIPWRIGHT_TEMPLATE_SEED");
    expect(source).not.toContain("await runTemplateSeed(");
  });

  it("feeds extension service deps into the platform app factories", () => {
    expect(source).toContain("...resolvedExtensions.apiDeps");
    expect(source).toContain("...resolvedExtensions.uiDeps");
  });

  it("only passes agent-detail card slots when an extension contributed some", () => {
    expect(source).toContain("resolvedExtensions.agentDetailCards.length > 0");
  });

  it("keeps the platform boot free of any coding extension import", () => {
    expect(source).not.toContain("coding-admin-extension");
    expect(source).not.toContain("./coding/");
    expect(source).not.toContain("AgentPhaseMethodologyService");
  });

  it("exports startAdmin(extensions) from admin-boot.ts", () => {
    expect(source).toContain("export async function startAdmin(");
  });
});

describe("main.ts composition root", () => {
  it("builds no services, routes or sweepers itself", () => {
    for (const forbidden of [
      "new Hono(",
      "const server = Bun.serve(",
      "setInterval(",
      "createAdminPrismaClient(",
      "new AgentService(",
    ]) {
      expect(entrySource).not.toContain(forbidden);
    }
    expect(entrySource.split("\n").length).toBeLessThan(80);
  });

  it("runs only when invoked as the main entry (import-safe)", () => {
    expect(entrySource).toContain("if (import.meta.main) {");
    expect(entrySource).toContain('"[admin] fatal startup error:"');
  });
});
