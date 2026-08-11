import { describe, expect, it } from "vitest";
import { classifyKind, extractSessionId, isShellWrapperCommand } from "./agent-process-classify.js";

// 2026-08-08 に実測した実コマンドライン。spawn は cmd /d /s /c 経由で Lictor を起動するため、
// ラッパと本体の両方に lictor.mjs が現れる。
const SHELL_WRAPPER =
  'cmd.exe /d /s /c "^"node^" ^"C:\\workspace\\Lictor\\bin\\lictor.mjs^" ^"claude^" ^"--model^" ^"claude-opus-5^" & exit 0"';
const LICTOR_BODY = '"node"  "C:\\workspace\\Lictor\\bin\\lictor.mjs" "claude" "--model" "claude-opus-5"';
const AGENT_CLIENT =
  '"C:\\Program Files\\nodejs\\node.exe" C:/workspace/Concordia/tools/concordia-agent-client.mjs --session abc-123 --url ws://127.0.0.1:11111/ws';

describe("isShellWrapperCommand", () => {
  it("detects the cmd /d /s /c wrapper used by spawn", () => {
    expect(isShellWrapperCommand(SHELL_WRAPPER)).toBe(true);
  });

  it("detects POSIX sh -c delegation", () => {
    expect(isShellWrapperCommand("/bin/sh -c 'node bin/lictor.mjs claude'")).toBe(true);
    expect(isShellWrapperCommand("bash -lc 'node bin/lictor.mjs claude'")).toBe(true);
    expect(isShellWrapperCommand("bash -x -c 'node bin/lictor.mjs claude'")).toBe(true);
  });

  it("does not treat the agent process itself as a wrapper", () => {
    expect(isShellWrapperCommand(LICTOR_BODY)).toBe(false);
    expect(isShellWrapperCommand(AGENT_CLIENT)).toBe(false);
  });
});

describe("classifyKind", () => {
  it("classifies the Lictor body but not its shell wrapper", () => {
    expect(classifyKind(LICTOR_BODY)).toBe("lictor");
    expect(classifyKind(SHELL_WRAPPER)).toBe(null);
  });

  it("classifies agent-client", () => {
    expect(classifyKind(AGENT_CLIENT)).toBe("agent-client");
  });

  it("rejects a shell image even when the command line looks bare", () => {
    // conhost/cmd が引数だけ引き継いだような形でも image 名で弾く。
    expect(classifyKind('"node" "bin/lictor.mjs"', "cmd.exe")).toBe(null);
    expect(classifyKind('"node" "bin/lictor.mjs"', "node.exe")).toBe("lictor");
  });

  it("ignores unrelated processes", () => {
    expect(classifyKind('"node" "dist/server.js"')).toBe(null);
  });
});

describe("extractSessionId", () => {
  it("reads --session", () => {
    expect(extractSessionId(AGENT_CLIENT)).toBe("abc-123");
  });

  it("returns null when absent", () => {
    expect(extractSessionId(LICTOR_BODY)).toBe(null);
  });
});
