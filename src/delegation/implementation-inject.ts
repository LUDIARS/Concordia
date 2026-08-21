/**
 * 実装委託の初回 inject 本文の組み立て — 純関数。
 *
 * 背景 (2026-08-21 neco 指示): 委託は「調査ブリーフ → 実装タスク」の 2 段階で渡していたが、
 * 終わり方が不安定だった (第 1 段階で止まる / 第 2 段階が届かない / codex-sdk は 1 ターンで
 * 終了して沈黙故障)。 現行のコードベース把握は Anatomia の解析グラフを引けば済むため、
 * **段階を廃止して 1 通で全部渡す**。
 *
 * 1 通の中身は「なぜ (why) + 実装タスク + Memoria タスク + 完了条件」。 委託先が調査から
 * 実装・完了報告までを止まらずに通せる最小の情報セットにする。
 *
 * このファイルは「何を書くか」だけを持つ。 いつ送るか / Memoria への起票は
 * delegation/service.ts と memoria-task.ts が持つ。
 *
 * spec/feature/delegation-implementation-inject.md。
 */

/** 実装委託とみなす作業種別。 kind 語彙は inject_manuals と同じ (manual-kind.ts)。 */
export const IMPLEMENTATION_MANUAL_KIND = "実装";

/** 見出しの最大長 (これを超えたら切り詰める)。 */
const HEADLINE_MAX = 160;

/** タスク本文から 1 行の見出しを取り出す (Memoria タスク名・ログ用)。 */
export function taskHeadline(renderedPrompt: string, fallback: string): string {
  const line = renderedPrompt
    .split(/\r?\n/)
    .map((s) => s.replace(/^#+\s*/, "").trim())
    .find((s) => s.length > 0);
  const headline = (line ?? fallback).trim() || fallback;
  return headline.length > HEADLINE_MAX ? `${headline.slice(0, HEADLINE_MAX - 1)}…` : headline;
}

export interface MemoriaTaskLink {
  id: string;
  url: string;
}

export interface ImplementationInjectInput {
  runId: string;
  title: string;
  /** タスク本文 (= rendered_prompt)。 伏せずに初回で全部渡す。 */
  task: string;
  /** なぜこの実装をするのか。 args の why/reason/problem → 既定文の順で解決済みの値。 */
  why: string;
  memoria: MemoriaTaskLink | null;
  /** Memoria タスクを作れなかったときの理由 (memoria=null のとき表示する)。 */
  memoriaError: string | null;
  repoPath: string | null;
  branch: string | null;
  concordiaUrl: string;
}

/**
 * 実装委託の本文 (prompt file の `## Prompt` 節に入る)。
 *
 * 事前調査は「まず Anatomia の解析グラフを引く」に寄せる。 Concordia が調査ブリーフを
 * 出して待つ形は廃止したので、 調査も実装も同じターンの中で委託先が進める。
 */
export function buildImplementationInject(input: ImplementationInjectInput): string {
  const statusEndpoint = `${trimSlash(input.concordiaUrl)}/v1/delegation/runs/${input.runId}/status`;
  const lines = [
    `## 実装タスク — ${input.title}`,
    "",
    "通常の不明点では停止せず、 コードと spec を根拠に自分で判断して実装まで進めてください。",
    "",
    "### なぜ (why)",
    "",
    input.why.trim(),
    "",
    "### 実装タスク",
    "",
    input.task.trim(),
    "",
    "### 着手前の把握 (調査は自分で回す)",
    "",
    "- コードの配置・既存実装・影響範囲は **Anatomia の解析グラフ**から引きます",
    "  (`/anatomia-analyze` の supply → CLI の `find` / `where` / `context`)。 POSIX `find` は使いません。",
    "- 仕様・タスク定義は対象リポの `spec/` / `spec/tasks/` を読みます (`/spec-task-supporter`)。",
    "- 調査結果を報告して指示を待つ工程はありません。 分かった時点でそのまま実装に入ります。",
    "",
    "### Memoria タスク",
    "",
  ];
  if (input.memoria) {
    lines.push(`- id: ${input.memoria.id}`, `- link: ${input.memoria.url}`);
  } else {
    // 未作成を黙って省略しない。 追跡タスクが無いこと自体が申し送り事項。
    lines.push(`- 未作成: ${input.memoriaError ?? "reason unknown"}`, "- 実装は進めてよい。 完了報告にこの事実を含めること。");
  }
  lines.push(
    "",
    "### 完了条件 (すべて満たしてから status を報告する)",
    "",
    "- [ ] 仕様を更新した (`spec/feature/` または `spec/tasks/`)",
    "- [ ] 実装した",
    "- [ ] 回帰テストを追加/更新した",
    "- [ ] 変更を commit した (`.git` に書けない環境なら `.concordia-commit.json` で Concordia に依頼する)",
    "- [ ] Revisor local PR を提出した",
    `- [ ] \`POST ${statusEndpoint}\` に completed を報告した`,
    "",
    "報告まで終わったら **このセッションは終了**します。 次のタスクを自分で拾わないでください。",
    "",
  );
  if (input.repoPath) {
    lines.push(
      `作業対象は \`${input.repoPath}\`${input.branch ? ` (branch: \`${input.branch}\`)` : ""} のみです。`,
      "- 編集はこの worktree / branch の中だけ。 main / develop へ直接コミットしない。",
      "- 既存の無関係な未コミット変更には触らない。",
      "- サービスの起動・再起動・起動テストはしない (必要になったら cc-test の claim/release と Excubitor を使う)。",
      "- merge / squash merge / auto-merge / main 更新は、 明示指示があるまでしない。",
      "",
    );
  }
  return lines.join("\n");
}

export interface MemoriaTaskDraft {
  title: string;
  details: string;
}

/** Memoria へ登録するタスクの下書き。 Memoria 側の契約は title/details のみに閉じる。 */
export function buildMemoriaTaskDraft(input: {
  runId: string;
  callName: string;
  title: string;
  task: string;
  why: string;
  repoPath: string | null;
}): MemoriaTaskDraft {
  const headline = taskHeadline(input.task, input.title);
  return {
    title: `[${input.callName}] ${headline}`,
    details: [
      `why: ${input.why.trim()}`,
      "",
      "task:",
      input.task.trim(),
      "",
      `repo: ${input.repoPath ?? "(unresolved)"}`,
      `delegation run: ${input.runId}`,
    ].join("\n"),
  };
}

/** why の解決順: 明示 args → 既定文。 LLM は介在しない。 */
export function resolveWhy(input: { args: Record<string, unknown>; title: string }): string {
  for (const key of ["why", "reason", "problem", "background"]) {
    const value = input.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `委託テンプレ「${input.title}」の目的を達成するための実装。`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
