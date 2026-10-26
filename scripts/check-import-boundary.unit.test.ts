import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkBoundary } from "./check-import-boundary";

let root: string;

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boundary-"));
  write("lib/util.ts", "export const util = 1;\n");
  write("runtime/boot.ts", "export const boot = 1;\n");
  write("admin/src/app.ts", "export const app = 1;\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("chat import boundary", () => {
  it("allows chat to import its own files, agent-lib modules and npm packages", () => {
    write("chat/src/local.ts", "export const local = 1;\n");
    write(
      "chat/src/app.ts",
      [
        'import { local } from "./local";',
        'import { util } from "@app-vitals/agent-lib/util";',
        'import { Hono } from "hono";',
        'import { join } from "node:path";',
      ].join("\n"),
    );
    expect(checkBoundary(root)).toEqual([]);
  });

  it("fails when chat imports runtime/ by relative path", () => {
    write("chat/src/app.ts", 'import { boot } from "../../runtime/boot";\n');
    expect(checkBoundary(root)).toEqual([
      {
        file: join("chat", "src", "app.ts"),
        specifier: "../../runtime/boot",
        reason: "chat may not import outside chat/",
      },
    ]);
  });

  it("fails when chat imports admin/ by relative path", () => {
    write("chat/src/app.ts", 'import { app } from "../../admin/src/app";\n');
    const [violation] = checkBoundary(root);
    expect(violation.specifier).toBe("../../admin/src/app");
    expect(violation.reason).toBe("chat may not import outside chat/");
  });

  it("fails when chat imports the runtime or admin workspace packages", () => {
    write(
      "chat/src/app.ts",
      [
        'import { x } from "@app-vitals/agent-runtime/boot";',
        'import { y } from "@app-vitals/agent-admin";',
      ].join("\n"),
    );
    expect(checkBoundary(root).map((v) => v.reason)).toEqual([
      "chat may not import the agent-runtime workspace",
      "chat may not import the agent-admin workspace",
    ]);
  });

  it("does not apply the chat restriction to other workspaces", () => {
    write(
      "admin/src/uses-runtime.ts",
      'import { boot } from "@app-vitals/agent-runtime/boot";\n',
    );
    expect(checkBoundary(root)).toEqual([]);
  });
});
