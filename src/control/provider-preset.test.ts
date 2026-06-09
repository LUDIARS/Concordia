import { describe, it, expect } from "vitest";
import { resolveDelegationSpawn, GAMMA_DEFAULT_MODEL } from "./provider-preset.js";

describe("resolveDelegationSpawn", () => {
  it("gamma → codex CLI + OSS/Ollama flags + 既定モデル", () => {
    const r = resolveDelegationSpawn("gamma", null);
    expect(r.provider).toBe("codex");
    expect(r.args).toEqual(["--oss", "--local-provider", "ollama", "--model", GAMMA_DEFAULT_MODEL]);
    expect(r.effectiveModel).toBe(GAMMA_DEFAULT_MODEL);
  });

  it("gamma + 明示モデルは override される", () => {
    const r = resolveDelegationSpawn("gamma", "qwen2.5-coder:14b");
    expect(r.provider).toBe("codex");
    expect(r.args).toContain("qwen2.5-coder:14b");
    expect(r.args).not.toContain(GAMMA_DEFAULT_MODEL);
    expect(r.effectiveModel).toBe("qwen2.5-coder:14b");
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

  it("claude / gemini も素通し (gamma 以外は OSS フラグを付けない)", () => {
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
    expect(resolveDelegationSpawn("gamma", "  ").effectiveModel).toBe(GAMMA_DEFAULT_MODEL);
  });
});
