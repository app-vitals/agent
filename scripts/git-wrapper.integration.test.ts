// Integration tests for scripts/bin/git. Real subprocesses: the wrapper's job
// is shell plumbing (global-option parsing, PATH stripping, exec), so mocks
// would miss the behavior under test. Stubs: a recording `git` standing in for
// the real one, and a recording `bun` standing in for the signed-push helper
// invocation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN_DIR = join(import.meta.dir, "bin");
const GIT_WRAPPER = join(BIN_DIR, "git");
const SIGNED_PUSH = join(import.meta.dir, "signed-push.ts");
let root: string;
let home: string;
let stubDir: string;
let workDir: string;

function writeExec(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** App auth: default token plus per-owner files. */
function setAppAuth(): void {
  writeFileSync(join(home, "gh-token"), "default-token");
  mkdirSync(join(home, "gh-token.d"));
  writeFileSync(join(home, "gh-token.d", "acme"), "acme-token");
}

interface RunOpts {
  env?: Record<string, string>;
  path?: string[];
  app?: boolean;
}

function runGit(args: string[], opts: RunOpts = {}) {
  return spawnSync(
    opts.path ? join(opts.path[0] as string, "git") : GIT_WRAPPER,
    args,
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: [...(opts.path ?? []), BIN_DIR, stubDir, "/usr/bin", "/bin"].join(
          ":",
        ),
        ...(opts.app === false
          ? {}
          : { GH_TOKEN_FILE: join(home, "gh-token") }),
        ...opts.env,
      },
    },
  );
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "git-wrapper-")));
  home = join(root, "home");
  stubDir = join(root, "stub");
  workDir = join(root, "work");
  for (const d of [home, stubDir, workDir]) mkdirSync(d);
  // Stub real git: records its args and the PATH it saw.
  writeExec(
    join(stubDir, "git"),
    '#!/usr/bin/env bash\necho "REAL-GIT ARGS=$*"\necho "PATH=$PATH" >&2\n',
  );
  // Stub bun: records the script, args, cwd and injected git config.
  writeExec(
    join(stubDir, "bun"),
    '#!/usr/bin/env bash\necho "BUN SCRIPT=$1 ARGS=${*:2} CWD=$PWD CONFIG=${GIT_CONFIG_COUNT:-0}:${GIT_CONFIG_KEY_0:-}=${GIT_CONFIG_VALUE_0:-}"\n',
  );
  setAppAuth();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git wrapper — passthrough", () => {
  test("non-push subcommands exec the real git unchanged, flag on", () => {
    const r = runGit(["status", "--short"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("REAL-GIT ARGS=status --short");
    expect(r.stdout).not.toContain("BUN");
  });

  test("global options before a non-push subcommand are forwarded verbatim", () => {
    const r = runGit(["-C", workDir, "-c", "a.b=c", "log", "-1"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1" },
    });
    expect(r.stdout).toContain(`REAL-GIT ARGS=-C ${workDir} -c a.b=c log -1`);
  });

  test("push with the flag unset passes through", () => {
    const r = runGit(["push", "origin", "feat/x"]);
    expect(r.stdout).toContain("REAL-GIT ARGS=push origin feat/x");
    expect(r.stdout).not.toContain("BUN");
  });

  test("push with the flag set to anything but 1 passes through", () => {
    const r = runGit(["push", "origin", "feat/x"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "0" },
    });
    expect(r.stdout).toContain("REAL-GIT ARGS=push origin feat/x");
  });

  test("SHIPWRIGHT_SIGNED_COMMITS=off bypasses interception and needs no owner hint", () => {
    const r = runGit(["push", "origin", "feat/x"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "off" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("REAL-GIT ARGS=push origin feat/x");
  });

  test("`push` as an option value is not mistaken for the subcommand", () => {
    const r = runGit(["-c", "alias.x=push", "status"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1" },
    });
    expect(r.stdout).toContain("REAL-GIT ARGS=-c alias.x=push status");
  });
});

describe("git wrapper — signed push interception", () => {
  test("push with flag=1 and an owner hint runs signed-push with the push args", () => {
    const r = runGit(["push", "-u", "origin", "feat/x"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1", SHIPWRIGHT_GH_OWNER: "acme" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`BUN SCRIPT=${SIGNED_PUSH}`);
    expect(r.stdout).toContain("ARGS=-u origin feat/x");
    expect(r.stdout).not.toContain("REAL-GIT");
  });

  test("-C push runs the helper in that directory", () => {
    const r = runGit(["-C", workDir, "push", "origin", "feat/x"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1", SHIPWRIGHT_GH_OWNER: "acme" },
    });
    expect(r.stdout).toContain("ARGS=origin feat/x");
    expect(r.stdout).toContain(`CWD=${workDir}`);
  });

  test("-c is handed to the helper as GIT_CONFIG_*", () => {
    const r = runGit(["-c", "user.name=bot", "push"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1", SHIPWRIGHT_GH_OWNER: "acme" },
    });
    expect(r.stdout).toContain("CONFIG=1:user.name=bot");
  });
});

describe("git wrapper — owner hint", () => {
  test("unset hint under app auth fails with the teaching error and runs nothing", () => {
    const r = runGit(["push", "origin", "feat/x"], {
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1" },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("SHIPWRIGHT_GH_OWNER");
    expect(r.stderr).toContain("each org has its own token");
    expect(r.stderr).toContain("SHIPWRIGHT_GH_OWNER=<org> git");
    expect(r.stderr).toContain("SHIPWRIGHT_SIGNED_COMMITS=off");
  });

  test("PAT mode (no GH_TOKEN_FILE) passes push through to the real git", () => {
    const r = runGit(["push", "origin", "feat/x"], {
      app: false,
      env: { SHIPWRIGHT_SIGNED_COMMITS: "1" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("REAL-GIT ARGS=push origin feat/x");
    expect(r.stdout).not.toContain("BUN");
  });

  test("PAT mode with a missing token file also passes through", () => {
    const r = runGit(["push"], {
      env: {
        SHIPWRIGHT_SIGNED_COMMITS: "1",
        GH_TOKEN_FILE: join(home, "does-not-exist"),
      },
    });
    expect(r.stdout).toContain("REAL-GIT ARGS=push");
  });
});

describe("git wrapper — no PATH recursion", () => {
  test("the real git is exec'd with the wrapper directory stripped from PATH", () => {
    const r = runGit(["status"]);
    expect(r.stderr).toContain(`PATH=${stubDir}:`);
    expect(r.stderr).not.toContain(BIN_DIR);
  });

  test("when no real git exists the wrapper exits 127 instead of looping", () => {
    const bashOnly = join(root, "bash-only");
    mkdirSync(bashOnly);
    for (const tool of ["bash", "dirname"]) {
      symlinkSync(realpathSync(`/usr/bin/${tool}`), join(bashOnly, tool));
    }
    const r = spawnSync(GIT_WRAPPER, ["status"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: `${BIN_DIR}:${bashOnly}` },
    });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("no real `git` found");
  });

  test("works when invoked through a symlink in another directory", () => {
    const linkDir = join(root, "link");
    mkdirSync(linkDir);
    symlinkSync(GIT_WRAPPER, join(linkDir, "git"));
    const r = spawnSync(join(linkDir, "git"), ["status"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: `${BIN_DIR}:${stubDir}:/usr/bin:/bin` },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("REAL-GIT ARGS=status");
  });
});
