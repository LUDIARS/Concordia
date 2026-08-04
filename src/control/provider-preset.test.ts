import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CODEX_DEFAULT_REASONING_EFFORT,
  delegationOptionSuggestions,
  GEMMA4_12_DEFAULT_MODEL,
  resolveDelegationRuntimeEnv,
  resolveDelegationRuntimeArgs,
  resolveDelegationSpawn,
  resolveEffectiveDelegationRuntimeOptions,
} from "./provider-preset.js";

describe("resolveDelegationSpawn", () => {
  it("gemma4-12 → Lictor ネイティブ local-agent (codex 経由しない) + LICTOR_LOCAL_MODEL env", () => {
    const r = resolveDelegationSpawn("gemma4-12", null);
    expect(r.provider).toBe("gemma4-12");
    expect(r.args).toEqual([]); // codex の --oss フラグは付けない
    expect(r.effectiveModel).toBe(GEMMA4_12_DEFAULT_MODEL);
    expect(r.env).toEqual({ LICTOR_LOCAL_MODEL: GEMMA4_12_DEFAULT_MODEL });
  });

  it("gemma4-12 + 明示モデルは env で override される", () => {
    const r = resolveDelegationSpawn("gemma4-12", "qwen2.5-coder:14b");
    expect(r.provider).toBe("gemma4-12");
    expect(r.args).toEqual([]);
    expect(r.effectiveModel).toBe("qwen2.5-coder:14b");
    expect(r.env).toEqual({ LICTOR_LOCAL_MODEL: "qwen2.5-coder:14b" });
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

describe("delegation runtime options", () => {
  it("suggests automatic effort for Codex and Claude", () => {
    expect(delegationOptionSuggestions("codex").map((s) => s.key)).toContain("model_reasoning_effort");
    expect(delegationOptionSuggestions("codex", "gpt-5.5").map((s) => s.key)).toContain("model_reasoning_effort");
    expect(delegationOptionSuggestions("codex")[0]?.choices?.map((choice) => choice.value)).toContain("xhigh");
    expect(delegationOptionSuggestions("codex", "gpt-3.5-turbo").map((s) => s.key)).toEqual(["goal_and_go"]);
    expect(delegationOptionSuggestions("claude").map((s) => s.key)).toEqual(["effort", "fast_mode", "goal_and_go"]);
    expect(delegationOptionSuggestions("claude")[0]?.choices?.map((choice) => choice.value)).toContain("auto");
  });

  it("suggests ultra reasoning effort only for the Sol model", () => {
    expect(delegationOptionSuggestions("codex", "gpt-5.6-sol")[0]?.choices?.map((c) => c.value)).toContain("ultra");
    expect(delegationOptionSuggestions("codex", "gpt-5.6-terra")[0]?.choices?.map((c) => c.value)).not.toContain("ultra");
    expect(delegationOptionSuggestions("codex", "gpt-5.5")[0]?.choices?.map((c) => c.value)).not.toContain("ultra");
  });

  it("passes goal-and-go opt-in to spawned Lictor for every provider", () => {
    expect(resolveDelegationRuntimeEnv("codex", { goal_and_go: true })).toEqual({
      CONCORDIA_DELEGATION_GOAL_AND_GO: "1",
    });
    expect(resolveDelegationRuntimeEnv("claude", {})).toEqual({});
  });

  it("resolveDelegationRuntimeEnv passes fast_mode through as CONCORDIA_DELEGATION_FAST_MODE for Claude only", () => {
    expect(resolveDelegationRuntimeEnv("claude", { fast_mode: true })).toEqual({
      CONCORDIA_DELEGATION_FAST_MODE: "1",
    });
    expect(resolveDelegationRuntimeEnv("codex", { fast_mode: true })).toEqual({});
    expect(resolveDelegationRuntimeEnv("claude", { fast_mode: true, goal_and_go: true })).toEqual({
      CONCORDIA_DELEGATION_FAST_MODE: "1",
      CONCORDIA_DELEGATION_GOAL_AND_GO: "1",
    });
  });

  it("defaults Codex reasoning effort to xhigh when unspecified", () => {
    expect(resolveEffectiveDelegationRuntimeOptions("codex", {})).toEqual({
      model_reasoning_effort: CODEX_DEFAULT_REASONING_EFFORT,
    });
    expect(resolveDelegationRuntimeArgs("codex", {})).toEqual([
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("passes Codex reasoning effort as one-shot config args", () => {
    expect(resolveDelegationRuntimeArgs("codex", { model_reasoning_effort: "high" })).toEqual([
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("passes Claude effort as one-shot CLI args", () => {
    expect(resolveDelegationRuntimeArgs("claude", { effort: "high" })).toEqual(["--effort", "high"]);
    expect(resolveDelegationRuntimeArgs("claude", { effort: "auto" })).toEqual([]);
  });

  it("passes extra Codex config options and ignores unsupported providers", () => {
    expect(resolveDelegationRuntimeArgs("codex", {
      codex_config: { sandbox_mode: "workspace-write", approval_policy: "never" },
    })).toEqual([
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
    ]);
    expect(resolveDelegationRuntimeArgs("claude", { model_reasoning_effort: "high" })).toEqual([]);
  });

  it("codex_config.network_access=false は転送しない (git push/PR/status callback を壊すため)", () => {
    expect(resolveDelegationRuntimeArgs("codex", {
      codex_config: { network_access: false, sandbox_mode: "workspace-write" },
    })).toEqual([
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'sandbox_mode="workspace-write"',
    ]);
    // 文字列表現の "false" も同様に無視する。
    expect(resolveDelegationRuntimeArgs("codex", {
      codex_config: { network_access: "false" },
    })).toEqual(["-c", 'model_reasoning_effort="xhigh"']);
    // true は通常どおり転送してよい (デフォルトの通信可能状態を明示するだけ)。
    expect(resolveDelegationRuntimeArgs("codex", {
      codex_config: { network_access: true },
    })).toEqual(["-c", 'model_reasoning_effort="xhigh"', "-c", "network_access=true"]);
  });

  it("codex_config.model は転送しない (model はモデル解決の専用経路のみが単一情報源)", () => {
    expect(resolveDelegationRuntimeArgs("codex", {
      codex_config: { model: "gpt-4o", sandbox_mode: "workspace-write" },
    })).toEqual([
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'sandbox_mode="workspace-write"',
    ]);
  });
});

describe("codex-sdk (Satelles headless) preset", () => {
  it("resolveDelegationSpawn: codex-sdk は --model のみ (effort は runtime args 側)", () => {
    const r = resolveDelegationSpawn("codex-sdk", "gpt-5.6-sol");
    expect(r.provider).toBe("codex-sdk");
    expect(r.args).toEqual(["--model", "gpt-5.6-sol"]);
    expect(r.effectiveModel).toBe("gpt-5.6-sol");
    const bare = resolveDelegationSpawn("codex-sdk", null);
    expect(bare.args).toEqual([]);
    expect(bare.effectiveModel).toBeNull();
  });

  it("resolveDelegationRuntimeArgs: codex-sdk は --effort (既定 xhigh) + --network、codex_config は転送しない", () => {
    expect(resolveDelegationRuntimeArgs("codex-sdk", {})).toEqual(["--effort", "xhigh", "--network"]);
    expect(resolveDelegationRuntimeArgs("codex-sdk", { model_reasoning_effort: "medium" }))
      .toEqual(["--effort", "medium", "--network"]);
    expect(resolveDelegationRuntimeArgs("codex-sdk", {
      model_reasoning_effort: "high",
      codex_config: { sandbox_mode: "workspace-write" },
    })).toEqual(["--effort", "high", "--network"]);
  });

  describe("無視した codex_config は warn する (無言のフォールバック禁止)", () => {
    let warn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      warn = vi.fn();
    });

    it("転送されないキーを 1 度の warn にまとめて出す", () => {
      resolveDelegationRuntimeArgs("codex-sdk", {
        codex_config: { sandbox_mode: "workspace-write", network_access: false },
      }, { warn });
      expect(warn).toHaveBeenCalledTimes(1);
      const [payload] = warn.mock.calls[0] as [{ provider: string; ignored_keys: string[] }];
      expect(payload.provider).toBe("codex-sdk");
      expect(payload.ignored_keys.sort()).toEqual(["network_access", "sandbox_mode"]);
    });

    it("尊重される model_reasoning_effort だけなら warn しない", () => {
      resolveDelegationRuntimeArgs("codex-sdk", {
        codex_config: { model_reasoning_effort: "high" },
      }, { warn });
      resolveDelegationRuntimeArgs("codex-sdk", { model_reasoning_effort: "high" }, { warn });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("resolveEffectiveDelegationRuntimeOptions: codex-sdk も既定 effort が入る", () => {
    expect(resolveEffectiveDelegationRuntimeOptions("codex-sdk", {}))
      .toEqual({ model_reasoning_effort: CODEX_DEFAULT_REASONING_EFFORT });
  });

  it("delegationOptionSuggestions: codex-sdk にも reasoning effort が出る (Sol なら ultra 含む)", () => {
    const keys = delegationOptionSuggestions("codex-sdk", "gpt-5.6-sol").map((s) => s.key);
    expect(keys).toContain("model_reasoning_effort");
    const effort = delegationOptionSuggestions("codex-sdk", "gpt-5.6-sol")
      .find((s) => s.key === "model_reasoning_effort");
    expect(effort?.choices?.some((c) => c.value === "ultra")).toBe(true);
  });
});
