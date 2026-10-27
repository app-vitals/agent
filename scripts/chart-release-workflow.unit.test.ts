import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const raw = readFileSync(
  join(root, ".github/workflows/chart-release.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf = (Bun.YAML.parse(raw) as any) ?? {};
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
type Step = Record<string, any>;

describe("chart release workflow", () => {
  test("the publish job reports whether it pushed a new chart version", () => {
    const job = wf.jobs.publish;
    expect(job.outputs.published).toBe("${{ steps.push.outputs.published }}");
    expect(job.outputs.version).toBe(
      "${{ steps.chart-version.outputs.version }}",
    );
    const push = job.steps.find((s: Step) => s.id === "push");
    expect(push.run).toContain('echo "published=true" >> "$GITHUB_OUTPUT"');
    expect(push.run).toContain('echo "published=false" >> "$GITHUB_OUTPUT"');
  });

  test("notifies shipwright with one chart-release dispatch carrying the version, only after a successful publish", () => {
    const job = wf.jobs["notify-shipwright"];
    expect(job.needs).toEqual(["publish"]);
    // No `!cancelled()`/`always()`: a failed or skipped publish dispatches nothing.
    expect(job.if).not.toContain("always()");
    expect(job.if).not.toContain("cancelled()");
    expect(job.if).toContain("needs.publish.result == 'success'");
    expect(job.if).toContain("needs.publish.outputs.published == 'true'");
    expect(job.env.VERSION).toBe("${{ needs.publish.outputs.version }}");
    const dispatches = job.steps.filter((s: Step) =>
      s.run?.includes("/dispatches"),
    );
    expect(dispatches).toHaveLength(1);
    const dispatch = dispatches[0];
    expect(dispatch.id).toBe("dispatch");
    expect(dispatch.env.GH_TOKEN).toBe("${{ secrets.DISPATCH_TOKEN }}");
    expect(dispatch.run).toContain("repos/app-vitals/shipwright/dispatches");
    expect(dispatch.run).toContain("event_type=chart-release");
    expect(dispatch.run).toContain("client_payload[version]=$VERSION");
  });

  test("a failed dispatch fails the workflow (no continue-on-error) and opens an issue", () => {
    const job = wf.jobs["notify-shipwright"];
    expect(job.permissions.issues).toBe("write");
    expect(job["continue-on-error"]).toBeUndefined();
    const dispatch = job.steps.find((s: Step) => s.id === "dispatch");
    expect(dispatch["continue-on-error"]).toBeUndefined();
    const alert = job.steps.find((s: Step) =>
      s.run?.includes("gh issue create"),
    );
    expect(alert.if).toContain("failure()");
    expect(alert.if).toContain("steps.dispatch.outcome == 'failure'");
    expect(alert.run).toContain("$VERSION");
  });
});
