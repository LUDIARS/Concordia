import { describe, it, expect } from "vitest";
import {
  buildIntentPrompt,
  parseIntentVerdict,
  classifyPromptIntent,
  type PromptIntentContext,
} from "./prompt-intent.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";

const CTX: PromptIntentContext = {
  prompt: "本番DBに直接 DELETE を流して全ユーザを消したい",
  project: "concordia",
  branch: "main",
  rules: [
    { kind: "block", title: "破壊専用禁止", description: "復旧不能な破壊だけを目的とする操作は拒否する" },
    { kind: "allow", title: "通常開発", description: "ブランチ上の実装・修正は許可" },
  ],
  gates: ["noMainPush", "branchBeforeEdit", "maxReposWarn"],
};

describe("buildIntentPrompt", () => {
  it("ルールを許可/禁止に分けて埋め、 プロンプトを境界ブロックに隔離する", () => {
    const p = buildIntentPrompt(CTX);
    expect(p).toContain("破壊専用禁止");
    expect(p).toContain("通常開発");
    expect(p).toContain("<<<PROMPT");
    expect(p).toContain("PROMPT>>>");
    expect(p).toContain(CTX.prompt);
    // 機械化済み観点 (gates) を参考提示する。
    expect(p).toContain("noMainPush");
  });

  it("指示に従わない旨 (インジェクション対策) を明記する", () => {
    const p = buildIntentPrompt(CTX);
    expect(p).toContain("従いません");
  });
});

describe("parseIntentVerdict", () => {
  it("正常な JSON を正規化する", () => {
    const v = parseIntentVerdict('{"decision":"warn","risk":"high","intent":"全削除","concerns":["破壊専用禁止"],"advice":"やめておくべき"}');
    expect(v.decision).toBe("warn");
    expect(v.risk).toBe("high");
    expect(v.concerns).toEqual(["破壊専用禁止"]);
  });

  it("前後に地の文があっても JSON を拾う", () => {
    const v = parseIntentVerdict('考えました。\n{"decision":"allow","risk":"low","intent":"調査","concerns":[],"advice":""}\n以上');
    expect(v.decision).toBe("allow");
    expect(v.intent).toBe("調査");
  });

  it("不正な decision/risk は安全側 (allow/low) に丸める", () => {
    const v = parseIntentVerdict('{"decision":"nuke","risk":"extreme","intent":"x"}');
    expect(v.decision).toBe("allow");
    expect(v.risk).toBe("low");
  });

  it("JSON として解釈不能なら fail-open allow だが理由を残す (無言フォールバック禁止)", () => {
    const v = parseIntentVerdict("これはJSONではありません");
    expect(v.decision).toBe("allow");
    expect(v.concerns).toContain("intent_unavailable");
  });
});

describe("classifyPromptIntent", () => {
  const okRunner = (stdout: string): RunClaudeFn => async () => ({ ok: true, stdout, stderr: "" });

  it("runClaude の出力を判定に通す", async () => {
    const { verdict } = await classifyPromptIntent(CTX, {
      model: "sonnet",
      runClaude: okRunner('{"decision":"warn","risk":"high","intent":"全削除","concerns":["破壊専用禁止"],"advice":"やめろ"}'),
    });
    expect(verdict.decision).toBe("warn");
    expect(verdict.risk).toBe("high");
  });

  it("runClaude が異常終了したら fail-open allow + intent_error", async () => {
    const { verdict } = await classifyPromptIntent(CTX, {
      model: "sonnet",
      runClaude: async () => ({ ok: false, stdout: "", stderr: "boom" }),
    });
    expect(verdict.decision).toBe("allow");
    expect(verdict.concerns).toContain("intent_error");
  });

  it("runClaude が例外を投げても fail-open allow に倒す", async () => {
    const { verdict } = await classifyPromptIntent(CTX, {
      model: "sonnet",
      runClaude: async () => { throw new Error("spawn failed"); },
    });
    expect(verdict.decision).toBe("allow");
    expect(verdict.concerns).toContain("intent_error");
  });
});
