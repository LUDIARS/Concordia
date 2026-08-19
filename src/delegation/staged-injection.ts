/**
 * 段階注入 (staged injection) の文面組み立て — 純関数。
 *
 * 背景: 実装委託の初回 inject は「タスク本文の丸投げ + 『方針が複数あり得るなら
 * ユーザの承認を待て』」という組み合わせだった。 Claude/Opus のように慎重な
 * 委託先は、 auto permission mode であっても初回ターンで質問を返して停止する
 * (「どのファイルを直しますか」「この方針でよいですか」)。 委託元は調査結果を
 * まだ持っていないので、 その質問には答えようがない。
 *
 * そこで実装委託を 2 段階に割る:
 *   第1段階 (投入時)  = 調査ブリーフ。 対象リポ・安全境界・調査姿勢だけを渡す。
 *                       通常の不明点で停止させない。 タスク本文は渡さない。
 *   第2段階 (調査後)  = 実装タスク。 理由 (why) + 具体タスク + Memoria タスク +
 *                       完了条件を 1 通にまとめて後追いで inject する。
 *
 * このファイルは「何を書くか」だけを持つ。 いつ送るか / 二重送信の抑止 / Memoria
 * への書き込みは staged-followup.ts と delegation_runs の列が持つ。
 *
 * spec/feature/delegation-staged-injection.md。
 */

/** 段階注入を適用する作業種別。 kind 語彙は inject_manuals と同じ (manual-kind.ts)。 */
export const STAGED_INJECTION_MANUAL_KIND = "実装";

/**
 * 段階注入を適用しない target_provider。
 *
 * `codex-sdk` は Satelles `run` (非対話・1 ターンで終了) で spawn される。 第1段階の
 * 調査報告を返した時点でプロセスが正常終了し、 第2段階の実装タスク inject は届かない
 * (run は `completed`、 commit ゼロ — 見た目は成功する最悪の沈黙故障)。
 * 非対話 runner にはタスク本文を初回に丸ごと渡す。 調査が要るタスクはそもそも渡さない。
 */
export const STAGED_INJECTION_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(["codex-sdk"]);

/** 調査テーマ見出しの最大長 (これを超えたら切り詰める)。 */
const HEADLINE_MAX = 160;

export interface StagedInjectionDecision {
  staged: boolean;
  /** staged=false のときの理由 (ログ・監査用)。 staged=true では null。 */
  reason: string | null;
}

/**
 * この run を段階注入にするか。
 *
 * - kind が「実装」以外 (レビュー / 設計相談 / テスト / 雑用) は対象外。 調査ブリーフの
 *   安全境界 (worktree / PR / commit) が噛み合わない。
 * - 対象リポジトリ (cwd) が解決できない run も対象外。 「どこを調べるか」を書けない。
 * - 明示的に無効化されている場合も対象外。
 * - 非対話 runner (codex-sdk = Satelles run) も対象外。 1 ターンで終了するため第2段階が届かない。
 */
export function decideStagedInjection(input: {
  manualKind: string;
  repoPath: string | null;
  enabled: boolean;
  /** run の target_provider (例 "claude", "codex", "codex-sdk")。 省略時は除外判定をしない。 */
  provider?: string | null;
}): StagedInjectionDecision {
  if (!input.enabled) return { staged: false, reason: "staged injection disabled by settings" };
  if (input.provider && STAGED_INJECTION_EXCLUDED_PROVIDERS.has(input.provider)) {
    return { staged: false, reason: `provider is non-interactive (single-turn runner): ${input.provider}` };
  }
  if (input.manualKind !== STAGED_INJECTION_MANUAL_KIND) {
    return { staged: false, reason: `manual kind is not ${STAGED_INJECTION_MANUAL_KIND}: ${input.manualKind}` };
  }
  if (!input.repoPath?.trim()) return { staged: false, reason: "target repository is unresolved" };
  return { staged: true, reason: null };
}

/**
 * タスク本文から 1 行の調査テーマを取り出す。 本文そのものは渡さない (丸投げ回避) が、
 * 「何について調べるのか」が無いと調査が始まらないため、 見出しだけを渡す。
 */
export function investigationHeadline(renderedPrompt: string, fallback: string): string {
  const line = renderedPrompt
    .split(/\r?\n/)
    .map((s) => s.replace(/^#+\s*/, "").trim())
    .find((s) => s.length > 0);
  const headline = (line ?? fallback).trim() || fallback;
  return headline.length > HEADLINE_MAX ? `${headline.slice(0, HEADLINE_MAX - 1)}…` : headline;
}

export interface InvestigationBriefInput {
  runId: string;
  /** テンプレ表示名。 見出しが取れなかったときの fallback にも使う。 */
  title: string;
  renderedPrompt: string;
  repoPath: string;
  branch: string | null;
  concordiaUrl: string;
}

/**
 * 第1段階の本文 (prompt file の `## Prompt` 節に入る)。
 *
 * 「停止しない」条件を否定形の禁止だけで書くと、 委託先は安全側に倒れて結局止まる。
 * 質問してよい 2 条件 (外部権限 / 本当に不可逆) を積極的に列挙して、 それ以外は
 * 自分で決める、 という形にする。
 */
export function buildInvestigationBrief(input: InvestigationBriefInput): string {
  const headline = investigationHeadline(input.renderedPrompt, input.title);
  const endpoint = `${trimSlash(input.concordiaUrl)}/v1/delegation/runs/${input.runId}/investigated`;
  return [
    "## 第 1 段階: 調査ブリーフ (実装タスクはまだ渡していません)",
    "",
    "これは調査の依頼です。 実装タスク本文・理由・完了条件は、 あなたの調査報告を受けてから",
    "Concordia が後追いで inject します。 **届く前に実装を始めないでください。**",
    "",
    `- 対象リポジトリ: \`${input.repoPath}\`${input.branch ? ` (branch: \`${input.branch}\`)` : ""}`,
    `- 調査テーマ: ${headline}`,
    "",
    "### 調査でやること",
    "",
    "1. 対象リポの現行コード・`spec/`・`spec/tasks/` を読み、 テーマに関係する実装・契約・既知の問題を特定する。",
    "2. 変更が要りそうな箇所、 影響範囲、 既存テストの有無を洗い出す。",
    "3. 下の報告 API を呼ぶ。 これが第 2 段階 (実装タスク) の引き金になる。",
    "",
    "### 通常の不明点で停止しない (重要)",
    "",
    "- どのファイルを触るか / 命名 / 実装順序 / テストの粒度 といった通常の不明点は、",
    "  **コードと spec を根拠に自分で決めて進めます**。 ユーザや親セッションに聞いて止まらないでください。",
    "- 質問してよいのは次の 2 つだけです。 いずれも調べた事実を根拠として添えてください。",
    "  - **外部権限が要る**とき (未取得の credential、 外部サービスへの書き込み、 リポジトリ外への公開)",
    "  - **本当に不可逆な選択**のとき (データ破壊、 履歴書き換え、 公開済み成果物の削除)",
    "- 上記に当たる事項は、 停止せずに報告 API の `blockers` へ入れて調査を続けてください。",
    "",
    "### 安全境界",
    "",
    "- 編集は上記 worktree / branch の中だけ。 main / develop へ直接コミットしない。",
    "- 既存の無関係な未コミット変更には触らない。",
    "- サービスの起動・再起動・起動テストはしない (必要になったら cc-test の claim/release と Excubitor を使う)。",
    "- merge / squash merge / auto-merge / main 更新は、 明示指示があるまでしない。",
    "- ユーザの明示指示が無い限りテストは実行しない (テストコードの追加・更新は実装の一部として行う)。",
    "",
    "### 調査完了の報告 (これを呼ぶと実装タスクが届きます)",
    "",
    `\`POST ${endpoint}\``,
    "",
    '  {"summary":"分かったこと 3-5 行","files":["調べた主要ファイル"],"blockers":["外部権限が要る事項 (無ければ省略)"]}',
    "",
    "報告は何度呼んでも安全です (Concordia 側で冪等に扱われ、 実装タスクは 1 度だけ届きます)。",
    "",
  ].join("\n");
}

export interface FollowupInjectInput {
  runId: string;
  title: string;
  /** タスク本文 (= 第1段階で伏せていた rendered_prompt)。 */
  task: string;
  /** なぜこの実装をするのか。 args の why/reason/problem → 調査 summary → 既定文の順で解決済みの値。 */
  why: string;
  memoria: MemoriaTaskLink | null;
  /** Memoria タスクを作れなかったときの理由 (memoria=null のとき表示する)。 */
  memoriaError: string | null;
  repoPath: string | null;
  branch: string | null;
  concordiaUrl: string;
}

export interface MemoriaTaskLink {
  id: string;
  url: string;
}

/** 第2段階の本文。 理由・タスク・Memoria タスク・完了条件を 1 通にまとめる。 */
export function buildFollowupInject(input: FollowupInjectInput): string {
  const statusEndpoint = `${trimSlash(input.concordiaUrl)}/v1/delegation/runs/${input.runId}/status`;
  const lines = [
    `## 第 2 段階: 実装タスク — ${input.title}`,
    "",
    "調査報告を受領しました。 ここからが実装です。 通常の不明点では停止せず、 調査で得た根拠に基づいて進めてください。",
    "",
    "### なぜ (why)",
    "",
    input.why.trim(),
    "",
    "### 実装タスク",
    "",
    input.task.trim(),
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
  );
  if (input.repoPath) {
    lines.push(
      `作業対象は \`${input.repoPath}\`${input.branch ? ` (branch: \`${input.branch}\`)` : ""} のみです。 第 1 段階の安全境界はそのまま有効です。`,
      "",
    );
  }
  return lines.join("\n");
}

/** Memoria タスクの追記だけを伝える補足 inject (実装タスクは配信済みのケース)。 */
export function buildMemoriaAttachmentNote(memoria: MemoriaTaskLink): string {
  return [
    "## Memoria タスクを登録しました (実装タスクは配信済み)",
    "",
    `- id: ${memoria.id}`,
    `- link: ${memoria.url}`,
    "",
    "完了報告にこの id を含めてください。",
  ].join("\n");
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
  const headline = investigationHeadline(input.task, input.title);
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

/** why の解決順: 明示 args → 調査報告 summary → 既定文。 LLM は介在しない。 */
export function resolveWhy(input: {
  args: Record<string, unknown>;
  investigationSummary: string | null;
  title: string;
}): string {
  for (const key of ["why", "reason", "problem", "background"]) {
    const value = input.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const summary = input.investigationSummary?.trim();
  if (summary) return `調査報告に基づく実装。 報告された現状:\n${summary}`;
  return `委託テンプレ「${input.title}」の目的を達成するための実装。`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
