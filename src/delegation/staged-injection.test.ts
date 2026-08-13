/**
 * 段階注入の文面まわりの回帰テスト。
 *
 * 守りたい性質は 2 つ:
 *   - 第1段階に「承認を待て」もタスク本文も漏れないこと (漏れると初回停止が再発する)
 *   - 第2段階に why / Memoria / 完了条件が必ず揃うこと
 *
 * spec/plan/problem_logs/2026-08-09-delegation-initial-inject-stall.md。
 */
import { describe, it, expect } from "vitest";
import {
  buildFollowupInject,
  buildInvestigationBrief,
  buildMemoriaAttachmentNote,
  buildMemoriaTaskDraft,
  decideStagedInjection,
  investigationHeadline,
  resolveWhy,
} from "./staged-injection.js";

const BRIEF_INPUT = {
  runId: "run-1",
  title: "実装委託 (Claude Opus 5)",
  renderedPrompt: "delegation workflow を段階注入へ直す\n\n詳細な手順がここに続く。\n- 手順 1\n- 手順 2",
  repoPath: "E:/Document/Ars/Concordia",
  branch: "feat/staged",
  concordiaUrl: "http://127.0.0.1:11111",
};

describe("decideStagedInjection", () => {
  it("kind=実装 + repo 解決済み + 有効 なら段階注入", () => {
    expect(decideStagedInjection({ manualKind: "実装", repoPath: "E:/repo", enabled: true }))
      .toEqual({ staged: true, reason: null });
  });

  it("実装以外の kind は対象外 (レビュー等は安全境界が噛み合わない)", () => {
    for (const kind of ["レビュー", "設計相談", "テスト", "雑用"]) {
      const decision = decideStagedInjection({ manualKind: kind, repoPath: "E:/repo", enabled: true });
      expect(decision.staged).toBe(false);
      expect(decision.reason).toContain(kind);
    }
  });

  it("対象リポジトリが解決できない run は対象外", () => {
    expect(decideStagedInjection({ manualKind: "実装", repoPath: null, enabled: true }).staged).toBe(false);
    expect(decideStagedInjection({ manualKind: "実装", repoPath: "   ", enabled: true }).staged).toBe(false);
  });

  it("設定で無効化されていれば対象外 (理由を残す)", () => {
    const decision = decideStagedInjection({ manualKind: "実装", repoPath: "E:/repo", enabled: false });
    expect(decision.staged).toBe(false);
    expect(decision.reason).toContain("disabled");
  });
});

describe("investigationHeadline", () => {
  it("最初の非空行を見出しにする (見出し記号は落とす)", () => {
    expect(investigationHeadline("# タイトル行\n\n本文", "fallback")).toBe("タイトル行");
  });

  it("空のプロンプトでは fallback を使う", () => {
    expect(investigationHeadline("\n\n   \n", "テンプレ名")).toBe("テンプレ名");
  });

  it("長すぎる見出しは切り詰める", () => {
    const headline = investigationHeadline("あ".repeat(400), "fallback");
    expect(headline.length).toBeLessThanOrEqual(160);
    expect(headline.endsWith("…")).toBe(true);
  });
});

describe("buildInvestigationBrief", () => {
  const brief = buildInvestigationBrief(BRIEF_INPUT);

  it("対象リポジトリと branch を明示する", () => {
    expect(brief).toContain("E:/Document/Ars/Concordia");
    expect(brief).toContain("feat/staged");
  });

  it("調査テーマは 1 行だけで、タスク本文の詳細は渡さない", () => {
    expect(brief).toContain("delegation workflow を段階注入へ直す");
    expect(brief).not.toContain("手順 1");
    expect(brief).not.toContain("手順 2");
  });

  it("通常の不明点で停止しない指示と、質問してよい 2 条件を含む", () => {
    expect(brief).toContain("停止しない");
    expect(brief).toContain("外部権限");
    expect(brief).toContain("不可逆");
  });

  it("承認待ちを促す文言を含まない (初回停止の再発防止)", () => {
    expect(brief).not.toContain("ユーザの承認を待");
    expect(brief).not.toContain("こう進めてよいですか");
  });

  it("安全境界 (main 直コミット禁止 / 再起動しない / 勝手に merge しない) を含む", () => {
    expect(brief).toContain("main / develop へ直接コミットしない");
    expect(brief).toContain("起動テストはしない");
    expect(brief).toContain("auto-merge");
  });

  it("調査完了の報告先 endpoint を run id つきで示す", () => {
    expect(brief).toContain("http://127.0.0.1:11111/v1/delegation/runs/run-1/investigated");
  });

  it("branch 不明でも壊れない", () => {
    const noBranch = buildInvestigationBrief({ ...BRIEF_INPUT, branch: null });
    expect(noBranch).toContain("E:/Document/Ars/Concordia");
    expect(noBranch).not.toContain("branch: ``");
  });
});

describe("buildFollowupInject", () => {
  const base = {
    runId: "run-1",
    title: "impl",
    task: "段階注入を実装する\n- 手順 1",
    why: "初回 inject の責務境界が壊れているため",
    repoPath: "E:/repo",
    branch: "feat/staged",
    concordiaUrl: "http://127.0.0.1:11111",
  };

  it("why / タスク本文 / Memoria / 完了条件を 1 通に揃える", () => {
    const text = buildFollowupInject({
      ...base,
      memoria: { id: "42", url: "http://127.0.0.1:5180/api/tasks/42" },
      memoriaError: null,
    });
    expect(text).toContain("### なぜ (why)");
    expect(text).toContain("初回 inject の責務境界が壊れているため");
    expect(text).toContain("手順 1");
    expect(text).toContain("- id: 42");
    expect(text).toContain("http://127.0.0.1:5180/api/tasks/42");
    expect(text).toContain("### 完了条件");
    expect(text).toContain("Revisor local PR");
  });

  it("Memoria タスクが無いときは黙って省略せず理由を書く", () => {
    const text = buildFollowupInject({ ...base, memoria: null, memoriaError: "connect ECONNREFUSED" });
    expect(text).toContain("未作成: connect ECONNREFUSED");
    expect(text).toContain("実装は進めてよい");
  });

  it("完了報告の endpoint を run id つきで示す", () => {
    const text = buildFollowupInject({ ...base, memoria: null, memoriaError: null });
    expect(text).toContain("http://127.0.0.1:11111/v1/delegation/runs/run-1/status");
  });
});

describe("resolveWhy", () => {
  it("args の明示 why を最優先する", () => {
    expect(resolveWhy({ args: { why: "神託" }, investigationSummary: "調査", title: "t" })).toBe("神託");
  });

  it("args が無ければ調査報告を根拠にする", () => {
    expect(resolveWhy({ args: {}, investigationSummary: "現状はこう", title: "t" }))
      .toContain("現状はこう");
  });

  it("どちらも無ければテンプレ名から既定文を作る (空文字にしない)", () => {
    const why = resolveWhy({ args: {}, investigationSummary: null, title: "実装委託" });
    expect(why).toContain("実装委託");
    expect(why.trim().length).toBeGreaterThan(0);
  });
});

describe("buildMemoriaTaskDraft", () => {
  it("title に call_name と見出し、details に why / task / repo / run を載せる", () => {
    const draft = buildMemoriaTaskDraft({
      runId: "run-1",
      callName: "claude-opus-5-impl",
      title: "impl",
      task: "段階注入を実装する\n詳細",
      why: "初回停止の解消",
      repoPath: "E:/repo",
    });
    expect(draft.title).toContain("claude-opus-5-impl");
    expect(draft.title).toContain("段階注入を実装する");
    expect(draft.details).toContain("why: 初回停止の解消");
    expect(draft.details).toContain("E:/repo");
    expect(draft.details).toContain("run-1");
  });
});

describe("buildMemoriaAttachmentNote", () => {
  it("id と link だけの短い補足になる (実装タスクを再送しない)", () => {
    const note = buildMemoriaAttachmentNote({ id: "7", url: "http://127.0.0.1:5180/api/tasks/7" });
    expect(note).toContain("- id: 7");
    expect(note).toContain("http://127.0.0.1:5180/api/tasks/7");
    expect(note).not.toContain("### 完了条件");
  });
});
