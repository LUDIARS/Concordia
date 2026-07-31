/**
 * getProvider registry のユニットテスト (T0-2).
 * 既存の挙動をそのまま固定する — 理想動作ではなく現挙動を記述する.
 */

import { describe, it, expect } from "vitest";
import { getProvider } from "./index.js";

describe("getProvider — 既知プロバイダ", () => {
  it("claude-code は非 null を返す", () => {
    const p = getProvider("claude-code");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("claude-code");
  });

  it("gemini-cli は非 null を返す", () => {
    const p = getProvider("gemini-cli");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("gemini-cli");
  });

  it("codex-cli は非 null を返す", () => {
    const p = getProvider("codex-cli");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("codex-cli");
  });
});

describe("getProvider — 未実装・不明プロバイダ", () => {
  it("local-llm は null を返す (専用 AgentProvider 未実装)", () => {
    expect(getProvider("local-llm")).toBeNull();
  });

  it("codex-sdk は null を返す (CLI 固有の recovery / rollout 走査を持たない)", () => {
    expect(getProvider("codex-sdk")).toBeNull();
  });

  it("unknown は null を返す", () => {
    expect(getProvider("unknown")).toBeNull();
  });

  it("完全に未知の文字列は null を返す", () => {
    expect(getProvider("gpt-4o")).toBeNull();
    expect(getProvider("")).toBeNull();
    expect(getProvider("CLAUDE-CODE")).toBeNull(); // 大文字小文字を区別する
  });
});

describe("getProvider — AgentProvider インタフェース準拠", () => {
  it("返された provider は必須メソッドを持つ", () => {
    for (const name of ["claude-code", "gemini-cli", "codex-cli"] as const) {
      const p = getProvider(name);
      expect(typeof p?.resolveSessionId).toBe("function");
      expect(typeof p?.transcriptPath).toBe("function");
      expect(typeof p?.parseTranscript).toBe("function");
    }
  });
});
