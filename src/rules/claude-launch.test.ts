import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { npmShimTarget, resolveClaudeLaunch } from "./claude-launch.js";

/** npm (cmd-shim) が作る claude.cmd の実例に近い形。 */
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*",
].join("\r\n");

const NPM_DIR = "C:\\Users\\u\\AppData\\Roaming\\npm";
const CLI_JS = join(NPM_DIR, "node_modules\\@anthropic-ai\\claude-code\\cli.js");

function fsOf(files: Record<string, string>) {
  return {
    exists: (path: string) => Object.hasOwn(files, path),
    readText: (path: string) => files[path] ?? "",
  };
}

describe("npmShimTarget", () => {
  it("reads the launched file from an npm cmd shim", () => {
    expect(npmShimTarget(NPM_SHIM)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(npmShimTarget("\"%~dp0\\node_modules\\x\\bin\\claude.exe\" %*")).toBe("node_modules\\x\\bin\\claude.exe");
    expect(npmShimTarget("@echo off")).toBeNull();
  });
});

describe("resolveClaudeLaunch", () => {
  it("prefers claude.exe on PATH", () => {
    const exe = join("C:\\tools", "claude.exe");
    const fs = fsOf({ [exe]: "", [join(NPM_DIR, "claude.cmd")]: NPM_SHIM, [CLI_JS]: "" });
    expect(resolveClaudeLaunch({ platform: "win32", env: { PATH: `C:\\tools;${NPM_DIR}` }, ...fs }))
      .toEqual({ file: exe, prefixArgs: [] });
  });

  it("runs the npm package's cli.js with Node when only claude.cmd exists (MELPOT)", () => {
    const fs = fsOf({ [join(NPM_DIR, "claude.cmd")]: NPM_SHIM, [CLI_JS]: "" });
    expect(resolveClaudeLaunch({ platform: "win32", env: { Path: NPM_DIR }, nodePath: "C:\\node\\node.exe", ...fs }))
      .toEqual({ file: "C:\\node\\node.exe", prefixArgs: [CLI_JS] });
  });

  it("falls back to the native install location, then to the bare name", () => {
    const native = join("C:\\Users\\u", ".local", "bin", "claude.exe");
    expect(resolveClaudeLaunch({ platform: "win32", env: { PATH: "", USERPROFILE: "C:\\Users\\u" }, ...fsOf({ [native]: "" }) }))
      .toEqual({ file: native, prefixArgs: [] });
    expect(resolveClaudeLaunch({ platform: "win32", env: { PATH: NPM_DIR }, ...fsOf({ [join(NPM_DIR, "claude.cmd")]: "@echo off" }) }))
      .toEqual({ file: "claude.exe", prefixArgs: [] });
  });

  it("uses the bare name outside Windows", () => {
    expect(resolveClaudeLaunch({ platform: "darwin" })).toEqual({ file: "claude", prefixArgs: [] });
  });
});
