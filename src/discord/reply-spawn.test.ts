import { describe, it, expect, vi } from "vitest";
import {
  parseJudgment,
  buildSpawnPrompt,
  buildJudgePrompt,
  maybeSpawnFromReply,
  type MaybeSpawnInput,
} from "./reply-spawn.js";

const baseInput: MaybeSpawnInput = {
  replyText: "これ haiku でやり直して、テストも足して",
  repliedToText: "認証まわりのリファクタ提案: トークン検証を分離する",
  repoPath: "E:/Document/Ars/Cernere",
};

describe("parseJudgment", () => {
  it("正常 JSON を正規化する", () => {
    const j = parseJudgment(`{"spawn": true, "model": "haiku", "instructions": "テスト追加"}`);
    expect(j).toEqual({ spawn: true, model: "haiku", instructions: "テスト追加" });
  });

  it("前後に地の文があっても JSON を拾う", () => {
    const j = parseJudgment(`判定します:\n{"spawn": false, "model": null, "instructions": ""}\n以上`);
    expect(j.spawn).toBe(false);
    expect(j.model).toBeNull();
  });

  it("壊れた出力は spawn=false に倒す", () => {
    expect(parseJudgment("not json at all")).toEqual({ spawn: false, model: null, instructions: "" });
  });

  it("model が空文字なら null", () => {
    expect(parseJudgment(`{"spawn":true,"model":"  ","instructions":"x"}`).model).toBeNull();
  });
});

describe("buildJudgePrompt / buildSpawnPrompt", () => {
  it("判定プロンプトに返信と返信先を両方含む", () => {
    const p = buildJudgePrompt(baseInput);
    expect(p).toContain("haiku でやり直して");
    expect(p).toContain("認証まわりのリファクタ");
    expect(p).toContain('"spawn"');
  });

  it("spawn プロンプトは元内容 + 追加指示を組む", () => {
    const p = buildSpawnPrompt(baseInput, { spawn: true, model: "haiku", instructions: "テストも足す" });
    expect(p).toContain("引き継ぎ作業");
    expect(p).toContain("認証まわりのリファクタ");
    expect(p).toContain("テストも足す");
  });
});

describe("maybeSpawnFromReply", () => {
  it("spawn=true → spawn を呼ぶ (model/cwd/prompt を渡す)", async () => {
    const spawn = vi.fn().mockResolvedValue({ ok: true });
    const run = vi.fn().mockResolvedValue({ ok: true, stdout: `{"spawn":true,"model":"haiku","instructions":"テスト追加"}` });
    const r = await maybeSpawnFromReply({ run, spawn }, baseInput);
    expect(r.spawned).toBe(true);
    expect(r.model).toBe("haiku");
    expect(spawn).toHaveBeenCalledOnce();
    const body = spawn.mock.calls[0][0];
    expect(body.model).toBe("haiku");
    expect(body.cwd).toBe("E:/Document/Ars/Cernere");
    expect(body.prompt).toContain("認証まわりのリファクタ");
    // 判定は haiku で行う
    expect(run.mock.calls[0][1]).toEqual({ model: "haiku" });
  });

  it("spawn=false (補足) → spawn を呼ばない", async () => {
    const spawn = vi.fn();
    const run = vi.fn().mockResolvedValue({ ok: true, stdout: `{"spawn":false,"model":null,"instructions":""}` });
    const r = await maybeSpawnFromReply({ run, spawn }, baseInput);
    expect(r.spawned).toBe(false);
    expect(r.reason).toBe("supplementary");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("空返信は判定すらせず no-op", async () => {
    const spawn = vi.fn();
    const run = vi.fn();
    const r = await maybeSpawnFromReply({ run, spawn }, { ...baseInput, replyText: "   " });
    expect(r.spawned).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("判定 run が失敗 → 補足扱い (spawn しない)", async () => {
    const spawn = vi.fn();
    const run = vi.fn().mockResolvedValue({ ok: false, stdout: "" });
    const r = await maybeSpawnFromReply({ run, spawn }, baseInput);
    expect(r.spawned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawn 失敗は spawned=false で理由を返す", async () => {
    const spawn = vi.fn().mockResolvedValue({ ok: false, error: "HTTP 500" });
    const run = vi.fn().mockResolvedValue({ ok: true, stdout: `{"spawn":true,"model":null,"instructions":"x"}` });
    const r = await maybeSpawnFromReply({ run, spawn }, baseInput);
    expect(r.spawned).toBe(false);
    expect(r.reason).toContain("HTTP 500");
  });
});
