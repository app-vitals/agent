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

  test("publish path is gated: resolve depends on guard and requires the tag be on main", () => {
    expect(wf.jobs.resolve.needs).toBe("guard");
    expect(wf.jobs.resolve.if).toContain("needs.guard.result != 'failure'");
    expect(wf.jobs["publish-npm"].needs).toBe("resolve");
    expect(wf.jobs["publish-image"].needs).toBe("resolve");
    expect(runText("resolve")).toContain("merge-base --is-ancestor");
    expect(runText("resolve")).toContain("origin/main");
  });

  test("every action is pinned to a full commit SHA", () => {
    // Local reusable-workflow calls (./...) are in-repo, not third-party.
    const uses = [...raw.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)]
      .map((m) => m[1])
      .filter((u) => !u.startsWith("./"));
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

  test("notifies shipwright with a platform-release dispatch carrying the version, after publishing", () => {
    const job = wf.jobs["notify-shipwright"];
    expect(job.needs).toEqual(["resolve", "publish-npm", "publish-image"]);
    expect(job.if).toContain("dry_run != 'true'");
    const dispatch = job.steps.find((s: Step) => s.id === "dispatch");
    expect(dispatch.env.GH_TOKEN).toBe("${{ secrets.DISPATCH_TOKEN }}");
    expect(dispatch.run).toContain("repos/app-vitals/shipwright/dispatches");
    expect(dispatch.run).toContain("event_type=platform-release");
    expect(dispatch.run).toContain("client_payload[version]=$VERSION");
    expect(job.env.VERSION).toBe("${{ needs.resolve.outputs.version }}");
  });

  test("a failed dispatch fails the workflow (no continue-on-error) and opens an issue", () => {
    const job = wf.jobs["notify-shipwright"];
    expect(job.permissions.issues).toBe("write");
    expect(job["continue-on-error"]).toBeUndefined();
    const dispatch = job.steps.find((s: Step) => s.id === "dispatch");
    expect(dispatch["continue-on-error"]).toBeUndefined();
    const alert = job.steps.find((s: Step) => s.run?.includes("gh issue create"));
    expect(alert.if).toContain("failure()");
    expect(alert.if).toContain("steps.dispatch.outcome == 'failure'");
    expect(alert.run).toContain("$VERSION");
  });
});

describe("consumer-smoke workflow", () => {
  const cRaw = readFileSync(
    join(root, ".github/workflows/consumer-smoke.yml"),
    "utf8",
  );
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  const cwf = (Bun.YAML.parse(cRaw) as any) ?? {};
  const cSteps: Step[] = Object.values<Step>(cwf.jobs).flatMap((j) => j.steps);
  const cRun = cSteps.map((s) => s.run ?? "").join("\n");

  test("is reusable and manually dispatchable with a version, no workflow_run", () => {
    expect(cwf.on.workflow_run).toBeUndefined();
    expect(cwf.on.workflow_call.inputs.version.type).toBe("string");
    expect(cwf.on.workflow_call.inputs.version.required).toBe(true);
    expect(cwf.on.workflow_dispatch.inputs.version.type).toBe("string");
  });

  test("release.yml calls it after publishing, never on dry runs", () => {
    const job = wf.jobs["consumer-smoke"];
    expect(job.uses).toBe("./.github/workflows/consumer-smoke.yml");
    expect(job.needs).toEqual(["resolve", "publish-npm", "publish-image"]);
    expect(job.if).toContain("needs.resolve.outputs.dry_run != 'true'");
    expect(job.with.version).toContain("needs.resolve.outputs.version");
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
  });

  test("least privilege, pinned actions, bun 1.4.3 with no cache", () => {
    expect(cwf.permissions).toEqual({ contents: "read" });
    const uses = [...cRaw.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(
      (m) => m[1],
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    // Same SHAs as release.yml.
    for (const u of uses) expect(raw).toContain(u);
    const bun = cSteps.find((s) => String(s.uses).includes("setup-bun"));
    expect(bun?.with["bun-version"]).toBe("1.4.3");
    expect(bun?.with["no-cache"]).toBe(true);
  });

  test("checks out the release tag and runs the script plus the base-image contract", () => {
    const checkout = cSteps.find((s) => String(s.uses).includes("checkout"));
    expect(checkout?.with.ref).toContain("refs/tags/");
    expect(checkout?.with["persist-credentials"]).toBe(false);
    expect(cRun).toContain("scripts/consumer-smoke.ts");
    expect(cRun).toContain(
      'SHIPWRIGHT_CONTRACT_BASE_IMAGE="ghcr.io/app-vitals/agent:$VERSION" bun test runtime/base-image-contract.smoke.test.ts',
    );
  });
});
