import { describe, it, expect } from "vitest";
import {
  buildImplementationInject,
  buildMemoriaTaskDraft,
  resolveWhy,
  taskHeadline,
} from "./implementation-inject.js";

const BASE = {
  runId: "run-1",
  title: "Concordia 委託テンプレ",
  task: "# Cc の委託終了処理を直す\n\n終了時に session-end する。",
  why: "終わり方が不安定だから",
  memoria: { id: "42", url: "http://127.0.0.1:7777/api/tasks/42" },
  memoriaError: null,
  repoPath: "E:/Document/Ars/Concordia",
  branch: "feat/cc-flow",
  concordiaUrl: "http://127.0.0.1:11111",
};

describe("taskHeadline", () => {
  it("最初の非空行を見出しにする (見出し記号は落とす)", () => {
    expect(taskHeadline("\n\n## タスクの見出し\n本文", "fallback")).toBe("タスクの見出し");
  });

  it("空のプロンプトでは fallback を使う", () => {
    expect(taskHeadline("   \n\n", "fallback")).toBe("fallback");
  });

  it("長すぎる見出しは切り詰める", () => {
    const headline = taskHeadline("あ".repeat(300), "fallback");
    expect(headline.length).toBe(160);
    expect(headline.endsWith("…")).toBe(true);
  });
});

describe("buildImplementationInject", () => {
  it("why / タスク本文 / Memoria / 完了条件を 1 通に揃える", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("## 実装タスク — Concordia 委託テンプレ");
    expect(text).toContain("終わり方が不安定だから");
    // タスク本文は伏せずに全文渡す (段階注入の廃止点)。
    expect(text).toContain("終了時に session-end する。");
    expect(text).toContain("- id: 42");
    expect(text).toContain("http://127.0.0.1:7777/api/tasks/42");
    expect(text).toContain("### 完了条件");
    expect(text).toContain("Revisor local PR を提出した");
  });

  it("調査ブリーフ工程を作らず、Anatomia の解析グラフへ寄せる", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("Anatomia の解析グラフ");
    expect(text).toContain("/anatomia-analyze");
    expect(text).toContain("調査結果を報告して指示を待つ工程はありません");
    expect(text).not.toContain("第 1 段階");
    expect(text).not.toContain("第 2 段階");
  });

  it("報告のあとは終了し、次のタスクを拾わないよう指示する", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("このセッションは終了");
    expect(text).toContain("次のタスクを自分で拾わないでください");
  });

  it("Memoria タスクが無いときは黙って省略せず理由を書く", () => {
    const text = buildImplementationInject({ ...BASE, memoria: null, memoriaError: "memoria unreachable" });
    expect(text).toContain("- 未作成: memoria unreachable");
    expect(text).toContain("実装は進めてよい");
  });

  it("安全境界 (main 直コミット禁止 / 再起動しない / 勝手に merge しない) を含む", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("main / develop へ直接コミットしない");
    expect(text).toContain("起動テストはしない");
    expect(text).toContain("merge / squash merge / auto-merge / main 更新は、 明示指示があるまでしない");
  });

  it("完了報告の endpoint を run id つきで示す", () => {
    expect(buildImplementationInject(BASE)).toContain("http://127.0.0.1:11111/v1/delegation/runs/run-1/status");
  });

  it("repo / branch 不明でも壊れない (安全境界節を落とすだけ)", () => {
    const text = buildImplementationInject({ ...BASE, repoPath: null, branch: null });
    expect(text).toContain("### 実装タスク");
    expect(text).not.toContain("作業対象は");
  });
});

describe("resolveWhy", () => {
  it("args の明示 why を最優先する", () => {
    expect(resolveWhy({ args: { why: "停止バグの解消", reason: "別" }, title: "T" })).toBe("停止バグの解消");
  });

  it("why が無ければ reason / problem / background を順に見る", () => {
    expect(resolveWhy({ args: { problem: "カード待ちで止まる" }, title: "T" })).toBe("カード待ちで止まる");
  });

  it("どれも無ければテンプレ名から既定文を作る (空文字にしない)", () => {
    const why = resolveWhy({ args: {}, title: "実装委託" });
    expect(why).toContain("実装委託");
    expect(why.trim().length).toBeGreaterThan(0);
  });
});

describe("buildMemoriaTaskDraft", () => {
  it("title に call_name と見出し、details に why / task / repo / run を載せる", () => {
    const draft = buildMemoriaTaskDraft({
      runId: "run-1",
      callName: "impl",
      title: "実装委託",
      task: "# Cc の委託終了処理を直す\n本文",
      why: "終わり方が不安定だから",
      repoPath: "E:/Document/Ars/Concordia",
    });
    expect(draft.title).toBe("[impl] Cc の委託終了処理を直す");
    expect(draft.details).toContain("why: 終わり方が不安定だから");
    expect(draft.details).toContain("repo: E:/Document/Ars/Concordia");
    expect(draft.details).toContain("delegation run: run-1");
  });

  it("repo 未解決も黙って落とさない", () => {
    const draft = buildMemoriaTaskDraft({
      runId: "run-2", callName: "impl", title: "実装委託", task: "本文", why: "why", repoPath: null,
    });
    expect(draft.details).toContain("repo: (unresolved)");
  });
});
