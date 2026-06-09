import { describe, it, expect } from "vitest";
import { resolveDelegationSpawn, GEMMA4_12_DEFAULT_MODEL } from "./provider-preset.js";

describe("resolveDelegationSpawn", () => {
  it("gemma4-12 → codex CLI + OSS/Ollama flags + 既定モデル", () => {
    const r = resolveDelegationSpawn("gemma4-12", null);
    expect(r.provider).toBe("codex");
    expect(r.args).toEqual(["--oss", "--local-provider", "ollama", "--model", GEMMA4_12_DEFAULT_MODEL]);
    expect(r.effectiveModel).toBe(GEMMA4_12_DEFAULT_MODEL);
  });

  it("gemma4-12 + 明示モデルは override される", () => {
    const r = resolveDelegationSpawn("gemma4-12", "qwen2.5-coder:14b");
    expect(r.provider).toBe("codex");
    expect(r.args).toContain("qwen2.5-coder:14b");
    expect(r.args).not.toContain(GEMMA4_12_DEFAULT_MODEL);
    expect(r.effectiveModel).toBe("qwen2.5-coder:14b");
  });

  it("旧名 gamma も後方互換で gemma4-12 と同じ解決 (DB 永続値の互換)", () => {
    expect(resolveDelegationSpawn("gamma", null)).toEqual(
      resolveDelegationSpawn("gemma4-12", null),
    );
  });

  it("codex は同名 CLI + model 指定時のみ --model", () => {
    expect(resolveDelegationSpawn("codex", "gpt-5.5")).toEqual({
      provider: "codex",
      args: ["--model", "gpt-5.5"],
      effectiveModel: "gpt-5.5",
    });
    expect(resolveDelegationSpawn("codex", null)).toEqual({
      provider: "codex",
      args: [],
      effectiveModel: null,
    });
  });

  it("claude / gemini も素通し (gemma4-12 以外は OSS フラグを付けない)", () => {
    const claude = resolveDelegationSpawn("claude", "claude-opus-4-8");
    expect(claude.provider).toBe("claude");
    expect(claude.args).toEqual(["--model", "claude-opus-4-8"]);
    expect(claude.args).not.toContain("--oss");

    const gemini = resolveDelegationSpawn("gemini", null);
    expect(gemini.provider).toBe("gemini");
    expect(gemini.args).toEqual([]);
  });

  it("空文字 model は未指定扱い", () => {
    expect(resolveDelegationSpawn("codex", "  ").args).toEqual([]);
    expect(resolveDelegationSpawn("gemma4-12", "  ").effectiveModel).toBe(GEMMA4_12_DEFAULT_MODEL);
  });
});
