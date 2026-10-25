import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const lock = readFileSync(join(root, "bun.lock"), "utf8");

const lockedVersion = (name: string): string => {
  const m = lock.match(new RegExp(`^\\s*"${name}": \\["${name}@([^"]+)"`, "m"));
  if (!m) throw new Error(`${name} is not in bun.lock`);
  return m[1];
};
const major = (v: string) => Number.parseInt(v, 10);

describe("release changelog preset", () => {
  // conventionalcommits@N targets conventional-changelog-writer@(N-1): the
  // preset's major runs one ahead of the writer major semantic-release's
  // release-notes-generator locks. A newer preset fails at generateNotes.
  test("preset major is not newer than the locked changelog writer supports", () => {
    const preset = major(
      lockedVersion("conventional-changelog-conventionalcommits"),
    );
    const writer = major(lockedVersion("conventional-changelog-writer"));
    expect(preset).toBeLessThanOrEqual(writer + 1);
  });

  test("the releaserc preset is the one the lockfile resolves", () => {
    const rc = JSON.parse(readFileSync(join(root, ".releaserc.json"), "utf8"));
    expect(JSON.stringify(rc.plugins)).toContain(
      '"preset":"conventionalcommits"',
    );
  });

  // The squash history references issue/PR numbers that do not exist in this
  // repo, so the github plugin's success step fails when it tries to comment.
  test("the github plugin does not comment on or label linked issues", () => {
    const rc = JSON.parse(readFileSync(join(root, ".releaserc.json"), "utf8"));
    const github = rc.plugins.find(
      (p: unknown) => Array.isArray(p) && p[0] === "@semantic-release/github",
    );
    expect(github?.[1]).toMatchObject({
      successComment: false,
      failComment: false,
      releasedLabels: false,
    });
  });
});
