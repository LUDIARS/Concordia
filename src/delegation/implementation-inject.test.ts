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
    expect(text).toContain("PR 提出より後段の完了条件");
    expect(text).toContain("failed / action_required");
    expect(text).toContain("対応完了を goal に置き");
    expect(text).toContain("修正・commit・再提出を終局条件まで継続");
    expect(text).toContain("その終局条件まで達した");
  });

  it("調査ブリーフ工程を作らず、Anatomia の解析グラフへ寄せる", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("Anatomia の解析グラフ");
    expect(text).toContain("/anatomia-analyze");
    expect(text).toContain("調査結果を報告して指示を待つ工程はありません");
    expect(text).not.toContain("第 1 段階");
    expect(text).not.toContain("第 2 段階");
  });

  it("着手時バンドル 6 手を番号付きでこの順に並べる", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("#### 着手時バンドル (この順で回す)");
    const steps = [
      "1. ドメインを定義する前にコードを書かない",
      "2. 再利用できる実装を解析グラフから探す",
      "3. テストを対で計画する (Anatomia `test-suggestions` → `augur plan`、減らすときは理由を書く)",
      "4. 実装 (src と tests を同じ変更単位で)",
      "5. 検証 (`git diff | anatomia verify`、Revisor gate は enforced、解析不能は fail)",
      "6. 回帰 (変更種別の既存テスト)",
    ];
    const positions = steps.map((step) => text.indexOf(step));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // 1 / 2 の補足 (宣言の置き場所・採否記載) も落とさない。
    expect(text).toContain("`spec/domains/<name>.domain.json` を先に書く、同じ PR に含める");
    expect(text).toContain("PR 説明に 1 行、見つけたら必ず使うではない");
    // バンドルは「着手前の把握」の中、Memoria 節より前に置く。
    expect(text.indexOf("### 着手前の把握")).toBeLessThan(text.indexOf("#### 着手時バンドル"));
    expect(text.indexOf("#### 着手時バンドル")).toBeLessThan(text.indexOf("### Memoria タスク"));
  });

  it("完了条件チェックリストにバンドル 3 手の担保行を含む", () => {
    const text = buildImplementationInject(BASE);
    expect(text).toContain("- [ ] 着地ドメインを Anatomia に登録した");
    expect(text).toContain("- [ ] 再利用探索の採否と理由を PR 説明に書いた");
    expect(text).toContain("- [ ] テスト計画 (`augur plan`) に沿って対のテストを実装した");
    expect(text.indexOf("- [ ] 着地ドメインを Anatomia に登録した")).toBeGreaterThan(
      text.indexOf("### 完了条件"),
    );
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
