import { describe, it, expect } from "vitest";
import {
  ACCEPTANCE_CONTRACT_ORDER_RULE,
  ACCEPTANCE_CONTRACT_FORMAT_RULE,
  ASK_MARKER_RULE,
} from "../taskflow/task-instructions.js";
import {
  buildImplementationInject,
  buildMemoriaTaskDraft,
  resolveWhy,
  taskHeadline,
} from "./implementation-inject.js";
import { majorInjectDefinition } from "../control/major-inject-catalog.js";

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
    expect(text).toContain("PR 提出より後段の完了条件");
    expect(text).toContain("failed / action_required");
    expect(text).toContain("対応完了を goal に置き");
    expect(text).toContain("修正・commit・再提出を終局条件まで継続");
    expect(text).toContain("その終局条件まで達した");
  });

  it("基本の調査案内は対象の実コードに基づき、未登録Anを必須にしない", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("対象リポジトリの設計資料と実コード");
    expect(text).not.toContain("Anatomia の解析グラフ");
    expect(text).not.toContain("/anatomia-analyze");
    expect(text).toContain("調査結果を報告して指示を待つ工程はありません");
    expect(text).not.toContain("第 1 段階");
    expect(text).not.toContain("第 2 段階");
  });

  it("基本の着手確認は対象資料・テスト・許可範囲の順に並ぶ", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("#### 着手時の確認");
    const steps = [
      "1. 対象リポジトリと既存設計を確認",
      "2. 必要なテストを計画",
      "3. 許可された検証を行い",
    ];
    const positions = steps.map((step) => text.indexOf(step));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).not.toContain("`anatomia plan --task");
    expect(text.indexOf("### 着手前の把握")).toBeLessThan(text.indexOf("#### 着手時の確認"));
    expect(text.indexOf("#### 着手時の確認")).toBeLessThan(text.indexOf("### Memoria タスク"));
  });

  it("完了条件は未登録Anの登録を一律要求せず、既存証跡を保つ", () => {
    const text = buildImplementationInject(BASE);
    expect(text).not.toContain("- [ ] 着地ドメインを Anatomia に登録した");
    expect(text).toContain("- [ ] 再利用探索の採否と理由を PR 説明に書いた");
    expect(text).toContain("- [ ] テスト計画 (`augur plan`) に沿って対のテストを実装した");
    expect(text).toContain("- [ ] Revisor local PR を提出した");
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
    expect(text).toContain("自分で git / gh merge せず Revisor の自動マージ通知を待つ");
  });

  it("完了報告の endpoint を run id つきで示す", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("http://127.0.0.1:11111/v1/delegation/runs/run-1/status");
    expect(text).toContain("400 `garbled_report`");
    expect(text).toContain("curl.exe --data-binary");
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

/**
 * 受け入れ条件は契約書式で渡し、 集計コマンドまで本文に書く
 * (spec/feature/task-workflow.md §5.1)。 文言は taskflow/task-instructions.ts が正本で、
 * persona-context と同じものを参照する (経路ごとに複製しない)。
 */
describe("buildImplementationInject — 受け入れ条件 (契約書式)", () => {
  it("契約書式と ask マーカー規則を 1 回ずつ載せる", () => {
    const text = buildImplementationInject({ ...BASE, augurCli: "node E:/x/Augur/bin/augur.mjs" });
    expect(text.split(ACCEPTANCE_CONTRACT_FORMAT_RULE).length - 1).toBe(1);
    expect(text.split(ASK_MARKER_RULE).length - 1).toBe(1);
    expect(text).toContain("### 受け入れ条件 (契約書式) と完了証跡");
  });

  it("解決済み Augur CLI のパスで集計コマンドを書く (ソースへ埋め込まない)", () => {
    const text = buildImplementationInject({ ...BASE, augurCli: "node E:/x/Augur/bin/augur.mjs" });
    expect(text).toContain("node E:/x/Augur/bin/augur.mjs contracts report --project . --acceptance --json --since $DELEGATION_STARTED_AT");
    expect(text).toContain("inject apply --project . --rule contract-wrap");
  });

  it("Augur が解決できない端末でも契約を先に作らせ、completed 不能を明示する", () => {
    const text = buildImplementationInject({ ...BASE, augurCli: null });
    expect(text).toContain(ACCEPTANCE_CONTRACT_FORMAT_RULE);
    expect(text).toContain(ACCEPTANCE_CONTRACT_ORDER_RULE);
    expect(text).not.toContain("contracts report");
    expect(text).toContain("Augur CLI を解決できなかった");
    expect(text).toContain("completed は拒否される");
  });

  it("受け入れ条件は完了条件チェックリストより前に置く", () => {
    const text = buildImplementationInject({ ...BASE, augurCli: null });
    expect(text.indexOf("### 受け入れ条件")).toBeLessThan(text.indexOf("### 完了条件"));
  });
});

describe("buildImplementationInject — editable full template", () => {
  it("uses the catalog factory default while retaining runtime task, Actio, Augur, branch, and run", () => {
    const template = majorInjectDefinition("delegation.implementation_inject")?.default_content;
    expect(template).toBeDefined();
    const rendered = buildImplementationInject({
      ...BASE,
      taskReference: "Actio:T-104",
      augurCli: "node E:/Augur/bin/augur.mjs",
      overrideTemplate: `Edited implementation introduction\n${template}`,
    });
    expect(rendered).toContain("Edited implementation introduction");
    expect(rendered).toContain("終了時に session-end する。");
    expect(rendered).toContain("Actio:T-104");
    expect(rendered).toContain("node E:/Augur/bin/augur.mjs contracts report");
    expect(rendered).toContain("feat/cc-flow");
    expect(rendered).toContain("/v1/delegation/runs/run-1/status");
    expect(rendered).not.toContain("[[CC:");
  });
});
