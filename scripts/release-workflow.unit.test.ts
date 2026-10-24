import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const raw = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf = (Bun.YAML.parse(raw) as any) ?? {};
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
type Step = Record<string, any>;
const stepsOf = (job: string): Step[] => wf.jobs[job].steps;
const runText = (job: string) =>
  stepsOf(job)
    .map((s) => s.run ?? "")
    .join("\n");

describe("release workflow", () => {
  test("triggers on release tags and manual dispatch with dry_run and tag inputs", () => {
    expect(wf.on.push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
    expect(wf.on.workflow_dispatch.inputs.dry_run.type).toBe("boolean");
    expect(wf.on.workflow_dispatch.inputs.tag.type).toBe("string");
  });

  test("every action is pinned to a full commit SHA", () => {
    const uses = [...raw.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  test("uses RELEASE_PAT, not the nonexistent GitHub App or an npm token", () => {
    expect(raw).toContain("secrets.RELEASE_PAT");
    expect(raw).not.toMatch(/RELEASE_APP_/);
    expect(raw).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  test("semantic-release dry run is selected by the dry_run input", () => {
    const steps = stepsOf("release");
    const dry = steps.find((s) => s.run === "bunx semantic-release --dry-run");
    const real = steps.find((s) => s.run === "bunx semantic-release");
    expect(dry?.if).toContain("inputs.dry_run");
    expect(real?.if).toContain("!inputs.dry_run");
  });

  test("npm publish uses OIDC trusted publishing with provenance, only in the publish job", () => {
    expect(wf.jobs["publish-npm"].permissions["id-token"]).toBe("write");
    for (const [name, job] of Object.entries<Step>(wf.jobs)) {
      if (name !== "publish-npm") {
        expect(job.permissions?.["id-token"]).toBeUndefined();
      }
    }
    const run = runText("publish-npm");
    expect(run).toContain("--provenance");
    expect(run).toContain("npm@^11.5.1");
    expect(wf.jobs["publish-npm"].strategy.matrix.package).toEqual([
      "lib",
      "runtime",
      "admin",
    ]);
  });

  test("npm publish is idempotent and honours dry run", () => {
    const run = runText("publish-npm");
    expect(run).toMatch(/npm view "\$NAME@\$VERSION"/);
    expect(run).toContain("exit 0");
    expect(run).toContain("FLAGS+=(--dry-run)");
  });

  test("images are built for both repos and pushed only outside dry run when absent", () => {
    const job = wf.jobs["publish-image"];
    expect(job.strategy.matrix.include).toEqual([
      { image: "agent", dockerfile: "runtime/Dockerfile" },
      { image: "agent-admin", dockerfile: "admin/Dockerfile" },
    ]);
    const push = stepsOf("publish-image").find((s) => s.name === "Push image");
    expect(push?.if).toContain("dry_run != 'true'");
    expect(push?.if).toContain("exists != 'true'");
    expect(runText("publish-image")).toContain("docker manifest inspect");
  });

  test("image guards run before the push step", () => {
    const names = stepsOf("publish-image").map((s) => s.name ?? s.uses);
    const idx = (n: string) => names.indexOf(n);
    expect(idx("Build image")).toBeGreaterThan(-1);
    expect(idx("Build image")).toBeLessThan(idx("Push image"));
    expect(
      idx("Verify browser launch under sandbox restrictions"),
    ).toBeLessThan(idx("Push image"));
    expect(idx("Base-image contract smoke test")).toBeLessThan(
      idx("Push image"),
    );
    expect(runText("publish-image")).toContain(
      "runtime/base-image-contract.smoke.test.ts",
    );
  });

  test("semantic-release no longer pushes commits to protected main", () => {
    const rc = JSON.parse(readFileSync(join(root, ".releaserc.json"), "utf8"));
    const names = rc.plugins.map((p: string | string[]) =>
      Array.isArray(p) ? p[0] : p,
    );
    expect(names).not.toContain("@semantic-release/git");
    expect(names).toContain("@semantic-release/github");
  });

  test("published packages are public and carry a repository for provenance", () => {
    for (const dir of ["lib", "runtime", "admin"]) {
      const pkg = JSON.parse(
        readFileSync(join(root, dir, "package.json"), "utf8"),
      );
      expect(pkg.private).toBeUndefined();
      expect(pkg.publishConfig.access).toBe("public");
      expect(pkg.repository.url).toContain("github.com/app-vitals/agent");
    }
  });
});
