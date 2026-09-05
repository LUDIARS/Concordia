/**
 * リアクションワークフロー (RWF) — chat メッセージへのリアクションを「指示」として解釈し、
 * 種類に応じた処理を headless claude (`claude -p --model …`) / session.inject で実行する。
 *
 * 設計 (spec/feature/reaction-workflow.md、spec/plan/2026-09-05-anatomia-domain-plan-tool.md §9〜§11):
 *  - reactions.ts が reaction 記録後に handle() を呼ぶ。
 *  - 写像は **「絵文字 → スキル」の一本**。 プロンプト本文は Castra のスキル
 *    (`.claude/skills/<name>/SKILL.md` / `.claude/commands/<name>.md`) が持ち、 Cc 側は
 *    「どの絵文字がどのスキルを、 どの mode / model / cwd で呼ぶか」だけを持つ
 *    (`CustomSkillWorkflowEntry`、 customWorkflows JSON に保存)。
 *    - mode=inject   … authoring session へ `/<skill> <args>` を流す。
 *    - mode=headless … SKILL.md 本文をシステム文脈として `claude -p` に渡す
 *                      (headless では skill 名が解決されないため)。
 *    - 非 active セッションでは inject 指定でも headless へ落ちる。
 *  - **組み込みのまま残すのは機械的操作だけ** (BUILTIN_ONLY_ACTIONS): 🙄 force-enter (CR 送信)、
 *    🔹📎 channel-rename、📮📬 submit-pr、📋 list-local-prs。 いずれも Cc API 直叩きで LLM 不要。
 *    🧠 context は read model (`contextReport`) が先に答え、 無い構成でだけスキルへ落ちる。
 *  - 組み込み写像 (`WORKFLOW_EMOJI`) は「どの絵文字が覆われるべきか」の期待値として残り、
 *    `migrateBuiltinWorkflowsToSkills()` が スキル側 frontmatter (`metadata.rwf`) から
 *    エントリを起こして JSON へ書き出す (`POST /v1/reaction-workflow/migrate-builtin`)。
 *    覆われなかった絵文字は `uncovered` として返る (無言で欠けさせない)。
 *
 * 解決順: 絵文字 → スキルエントリ → (無ければ) 管理設定の上書き / 組み込み写像 →
 * その action にスキルエントリがあればそれ → 自由プロンプトのカスタムワークフロー。
 *
 * カスタムワークフロー: add-as-workflow で登録した (emoji, prompt) ペアも同じ JSON に
 * 共存する (`CustomPromptWorkflowEntry`)。 スキル割り当ての無い絵文字だけが当たる。
 *
 * 安全弁: 既定 OFF。 enabled (CONCORDIA_REACTION_WORKFLOW=1) の時だけ実処理を走らせる。
 * headless 実行は file 書き込み / Memoria 連携を伴うので dangerouslySkipPermissions で起動する
 * (ローカル信頼自動化前提、 error-autofix と同じ運用思想)。
 * 対象メッセージは inject / headless のどちらでも `<reaction-message-data>` で囲んだ
 * 「信頼できない外部データ」として渡す。
 */

import { join } from "node:path";
import type { StaffCapability } from "../staff/roles.js";
import type { SkillCatalogEntry } from "../skills/catalog.js";
import { isWorkflowAction, WORKFLOW_ACTIONS, type WorkflowAction } from "./reaction-workflow-action.js";
import {
  clipWorkflowText as clip,
  DEFAULT_WORKFLOW_MODELS,
  isReservedNonActionEmoji,
  isSkillWorkflowEntry,
  workflowMessageReference,
  workflowPromptHead,
  type CustomSkillWorkflowEntry,
  type CustomWorkflowEntry,
  type WorkflowContext,
  type WorkflowMode,
  type WorkflowModels,
  type WorkflowPlan,
} from "./reaction-workflow-plan.js";
import {
  BUILTIN_ONLY_ACTIONS,
  DOMAIN_REVIEW_ACTION,
  buildSkillWorkflowSeed,
  findSkillEntryForAction,
  matchSkillEntry,
  mergeSkillEntries,
  planSkillWorkflow,
  READ_MODEL_FIRST_ACTIONS,
  type SkillWorkflowSeed,
} from "./reaction-workflow-skill.js";
import {
  readCustomWorkflows,
  resolveCustomWorkflowsPath,
  updateCustomWorkflows,
  writeCustomWorkflows,
} from "./reaction-workflow-store.js";
import {
  workflowActionCapability,
  workflowActionSubsidiaryAllowed,
  workflowDenialMessage,
  type WorkflowActionPolicies,
} from "./reaction-workflow-capability.js";
// 設定 GUI / API がアクション別ポリシーの既定値を参照できるよう、rwf module として再輸出する。
export {
  WORKFLOW_ACTION_POLICY_CAPABILITIES,
  workflowActionDefaults,
  type WorkflowActionPolicies,
} from "./reaction-workflow-capability.js";
import {
  describeMergeFallback,
  describePrListOutcome,
  describePrMergeOutcome,
  describePrSubmitOutcome,
  type RwfPrOperations,
} from "./reaction-workflow-pr.js";
import { stat } from "node:fs/promises";
import { ENTER_KEY_TEXT } from "./enter-key.js";
import {
  REACTION_WORKFLOW_SOURCE,
  type InjectionProvenance,
  type SessionInjectEmitter,
} from "../shared/injection-provenance.js";

/** path が存在するか (async existsSync 代替)。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ─── プラグイン契約: Concordia 内部に依存しない自己完結エンジンにするための型 ─────
// (ユーザカスタマイズ可能な別フォルダプラグインとして切り出すため、 eventBus /
//  claude-runner / enter-key への直接 import を排し、 すべて deps 注入で受ける。)

/** headless 実行 (runClaude 相当) のオプション。 engine が使うフィールドのみ。 */
export interface RwfRunOptions {
  model?: string;
  cwd?: string;
  dangerouslySkipPermissions?: boolean;
}

/** headless 実行の結果。 engine が参照するフィールドのみ。 */
export interface RwfRunResult {
  ok: boolean;
  stdout: string;
  exit_code: number | null;
  stderr: string;
  duration_ms: number;
}

// 語彙の正本は reaction-workflow-action.ts、 実行計画の契約は reaction-workflow-plan.ts。
// 権限の対応表とスキル写像がこれらだけを必要とするので実装から切り離してある (実装側から
// 型を借りると循環依存になり、 依存検査 no-circular が落ちる)。 ここでは従来どおりの
// import 元として再輸出する。
export type { WorkflowAction };
export {
  DEFAULT_WORKFLOW_MODELS,
  frameReactionMessageData,
  isReservedNonActionEmoji,
  isSkillWorkflowEntry,
  normalizeWorkflowEmoji,
  type CustomPromptWorkflowEntry,
  type CustomSkillWorkflowEntry,
  type CustomWorkflowEntry,
  type WorkflowContext,
  type WorkflowMode,
  type WorkflowModels,
  type WorkflowPlan,
} from "./reaction-workflow-plan.js";
export {
  BUILTIN_ONLY_ACTIONS,
  buildSkillWorkflowSeed,
  planSkillWorkflow,
  resolveSkillCwd,
  resolveSkillMode,
  resolveSkillModel,
  type SkillWorkflowSeed,
} from "./reaction-workflow-skill.js";
export {
  readCustomWorkflows,
  resolveCustomWorkflowsPath,
  writeCustomWorkflows,
} from "./reaction-workflow-store.js";

/**
 * リアクション絵文字 → WorkflowAction。 Discord は標準絵文字を unicode 文字 (👍 等) で、
 * `reaction.emoji.name` に渡してくる。 ここでは unicode 文字で照合する。
 *
 * 注意: discord-repo.classifyEmoji (fine/bad/raw 記録用) とは別系統。 ワークフロールータは
 * 「ok=🆗 → 着手」「check=✅ → 残作業タスク」のように細かく分岐する。
 */
const WORKFLOW_EMOJI: Record<WorkflowAction, readonly string[]> = {
  "context": ["🧠"],
  // 「良い」→ そのまま実装着手 (thumbsup / ok)
  "start-impl": ["👍", "🆗"],
  // 🙏 → 残作業を洗い出して報告 (2 段 WF の前段)
  "enumerate-remaining": ["🙏"],
  // 🫶 / 😴 / ✨ → 残作業を重複回避で Memoria に登録 (memoria-record。 🙏 洗い出しの後段)
  "memoria-remaining": ["🫶", "😴", "✨"],
  // 状況どう? → セッションに今の作業状況を報告させる (point-up / up / mobile 系)
  "status-check": ["📲", "🆙", "👆"],
  // 良い動き → リポ作業メモリに記録 (smile 系)
  "repo-memory-good": ["😄", "😀", "😃", "😊", "🙂", "😁"],
  // メッセージをメモに残す → Memoria メモ (eye / point-left / note / pencil 系)
  "memoria-note": ["👀", "👁️", "👁", "👈", "📓", "✏️", "✏"],
  // 残作業 → Memoria タスク (memo / check 系)
  "memoria-task": ["📝", "🗒️", "🗒", "✅", "☑️", "✔️", "✔"],
  // 良くない動き → リポ作業メモリに記録 (rage / bad 系)
  "repo-memory-bad": ["😡", "💢", "👿", "😠", "👎"],
  // 実装タスクを積んで別セッションへ委ねる (outbox / next / dividers 系)
  "defer-impl": ["⏭️", "⏭", "📤", "🗂️", "🗂"],
  // Enter を強制送信 (Lictor が送信を取りこぼした時の救済。 対象 session へ CR を inject)
  "force-enter": ["🙄"],
  // delegation に対応する絵文字 → Haiku でタスク判定 → タスクあり = delegation invoke
  "delegate-task": ["🤝", "🫱", "🫱🏻", "🫱🏼", "🫱🏽", "🫱🏾", "🫱🏿"],
  // このメッセージ本文をセッションチャンネル名に反映 (手動リネーム)
  "channel-rename": ["🔹", "📎"],
  // 当月目標外タスクの期日を来週 (+7日) に延期 (calendar 系)
  "reschedule-non-goal": ["📅", "🗓️", "🗓"],
  // 当月目標の実行可能タスクを実行
  "run-goal-tasks": ["🎯"],
  // 次セッション向けの引継ぎ資料を作る (wave)
  "handoff-document": ["👋"],
  // 中断していた作業を再開する「続けて」 (play / fast-forward 系)
  "resume-work": ["▶️", "▶", "⏩", "⏯️", "⏯"],
  // 対象セッションの作業ブランチを Revisor local PR として提出 (postbox / mailbox)
  "submit-pr": ["📮", "📬"],
  // Revisor local PR の一覧を出す (clipboard)。 セッションチャンネルならそのリポに絞る
  "list-local-prs": ["📋"],
  // 対象セッションが提出した open な Revisor local PR をマージする。 local PR が無いときだけ
  // 従来の GitHub squash merge 経路へ落とす (merge / rocket)
  "merge-pr": ["🔀", "🚀"],
  // 対応マージ後、メッセージで指定されたプロジェクトコードを main 最新に同期
  "sync-project-main-after-merge": ["🔄", "🔃"],
  // メッセージをカスタムワークフローとして JSON に登録 (tools 系)
  "add-as-workflow": ["🛠️", "🛠"],
  // 📑 ドメイン情報を投稿 / 🪬 ドメインレビューを開始 (設計 §9.2 C-7)
  "domain-report": ["📑"],
  "domain-review": ["🪬"],
};

// 語彙の一覧と予約絵文字の判定は正本モジュールから再輸出する。
export { WORKFLOW_ACTIONS, isWorkflowAction };

/**
 * アクションの代表絵文字 (写像の先頭)。 GUI から「絵文字を押した」のと同じ経路で
 * アクションを起こすために使う — 操作面ごとに別の実行経路を作らないための入口。
 */
export function primaryEmojiForAction(action: WorkflowAction): string {
  return WORKFLOW_EMOJI[action][0] ?? "";
}

/** 1 アクションのヘルプ (GUI / API で「このコマンドが何をするか」を見せる)。 */
export interface WorkflowActionHelp {
  /** 人間向けの短い名前。 */
  label: string;
  /** 何をするか (= 投稿内容をどんな指示に変換して渡すか)。 */
  summary: string;
  /** 実行手段の概要 (inject / headless + cwd + model)。 */
  mode: string;
}

/**
 * 各リアクションワークフロー (カスタムコマンド) の説明。 「投稿内容を変換して渡す」ので、
 * summary は「投稿内容を <どんな指示> に変換する」という形で書く。
 */
export const WORKFLOW_ACTION_HELP: Record<WorkflowAction, WorkflowActionHelp> = {
  "context": {
    label: "コンテキスト残量",
    summary: "対象セッションのコンテキスト占有と残量をその場で再推定してスレッドへ返す。",
    mode: "Concordia read model (LLM を起動しない)",
  },
  "start-impl": {
    label: "実装着手",
    summary: "投稿内容 (直前の提案 / 計画) を『そのまま実装に着手せよ』という指示に変換して渡す。",
    mode: "active セッションへ inject / 非active は headless (当該リポ)",
  },
  "enumerate-remaining": {
    label: "残作業の洗い出し",
    summary: "投稿内容を起点に『今やり残している残作業を洗い出して報告せよ』に変換して渡す。",
    mode: "active へ inject / 非active は headless sonnet (当該リポ)",
  },
  "memoria-remaining": {
    label: "残作業を Memoria に記録 (memoria-record)",
    summary: "投稿内容 (残作業の洗い出し結果) を『既存タスクと重複チェックした上で Memoria に登録せよ (memoria-record)』に変換して渡す。",
    mode: "headless sonnet (Memoria)",
  },
  "status-check": {
    label: "状況確認",
    summary: "投稿内容を起点に『今の作業状況 (進捗 / ブロック / 次の一手) を報告せよ』に変換して渡す。",
    mode: "active へ inject / 非active は headless sonnet (当該リポ)",
  },
  "repo-memory-good": {
    label: "良い動きをリポ作業メモリに記録",
    summary: "投稿内容を『このリポの作業メモリに“うまくいったパターン”として記録せよ』に変換して渡す。",
    mode: "headless haiku (当該リポ)",
  },
  "repo-memory-bad": {
    label: "作業中断 + 反省",
    summary: "投稿内容を『今の作業を直ちに中断して反省せよ。 記録は後続の 👍 が来た時だけ』に変換して渡す。",
    mode: "active へ inject / 非active は headless haiku (反省のみ)",
  },
  "memoria-note": {
    label: "Memoria にメモ",
    summary: "投稿内容を『要点を Memoria にメモとして記録せよ』に変換して渡す。",
    mode: "headless haiku (Memoria)",
  },
  "memoria-task": {
    label: "Memoria にタスク登録",
    summary: "投稿内容を『タスク (名前 / 完了条件 / 対象リポ) を確定して Memoria に登録せよ』に変換して渡す。",
    mode: "headless sonnet (Memoria)",
  },
  "defer-impl": {
    label: "実装タスクを別セッションへ委ねる",
    summary: "投稿内容を『実装タスクを抽出して Memoria に登録し、別セッション対応としてマークせよ』に変換して渡す。",
    mode: "headless sonnet (Memoria)",
  },
  "force-enter": {
    label: "Enter 強制送信 (Lictor 救済)",
    summary: "投稿内容を変換せず、 対象 session に CR を inject して送信を強制する (Lictor が Enter を取りこぼした時の救済)。",
    mode: "active セッションへ inject のみ (非 active はスキップ)",
  },
  "delegate-task": {
    label: "タスク委託実行",
    summary: "投稿内容を『Haiku でタスク判定 → タスクあり = 最適な delegation template を選んで invoke、なし = スキップ』に変換して渡す。",
    mode: "active へ inject (委託+監視) / 非active は headless haiku (委託のみ)",
  },
  "channel-rename": {
    label: "チャンネルリネーム",
    summary: "このメッセージ本文をセッションチャンネルの名前 (slug 化) に反映する。初回リポ選択後の手動リネーム手段。",
    mode: "API (Concordia /sessions/:id/title 直接呼び出し)",
  },
  "reschedule-non-goal": {
    label: "当月目標外タスクの期日延期",
    summary: "Memoria の未完了タスクのうち当月目標に関連しないものの期日を来週 (+7日) に延期する。",
    mode: "headless sonnet (Memoria)",
  },
  "run-goal-tasks": {
    label: "当月目標タスクを実行",
    summary: "投稿内容を起点に、当月目標に関連する Memoria タスクのうち AI が実行可能なものを実行する。",
    mode: "active へ inject / 非active は headless sonnet (当該リポ)",
  },
  "handoff-document": {
    label: "次セッションへの引継ぎ資料作成",
    summary: "投稿内容と現在の作業文脈から『次セッションへの引継ぎ資料 (現状 / 残作業 / 次の一手 / 注意点 / 関連ブランチ・PR・ファイル) を作成し session-logs に保存せよ』に変換して渡す。",
    mode: "active へ inject / 非active は headless sonnet (当該リポ)",
  },
  "resume-work": {
    label: "作業を続ける",
    summary: "投稿内容 (直近の作業 / 中断点) を起点に『中断していた作業の続きを再開せよ』に変換して渡す。",
    mode: "active へ inject / 非active は headless sonnet (当該リポ、 git 痕跡 + session-logs から文脈復元)",
  },
  "submit-pr": {
    label: "PR を提出する",
    summary: "対象セッションの作業ブランチを Revisor の local PR として提出する (POST /v1/prs/local と同じ実体)。 提出しなかった場合も理由を返す。",
    mode: "API (Concordia の local PR 提出をそのまま呼ぶ)",
  },
  "list-local-prs": {
    label: "Revisor local PR 一覧",
    summary:
      "Revisor local PR (LUDIARS で「PR」と言えば原則こちら) の一覧を表示する。" +
      " セッションチャンネルならそのリポジトリに絞る。 GitHub PR のキューは /prs で別系統。",
    mode: "API (Concordia の Revisor 読み取り口をそのまま呼ぶ、読み取り専用)",
  },
  "merge-pr": {
    label: "PR をマージする",
    summary: "対象セッションが提出した open な Revisor local PR を、 押した人の権限 (merge_pr) で確認した上でマージする。 local PR が無いときだけ『当該リポの open PR を squash merge せよ』という GitHub 経路の指示に変換して渡す。",
    mode: "API (Revisor local PR マージ) / local PR が無ければ active へ inject・非active は headless sonnet",
  },
  "sync-project-main-after-merge": {
    label: "対応マージ後に main 最新化",
    summary: "投稿内容の『対応マージ後、<project>をmain最新にする』から project code を抽出し、対応 PR がマージ済みであることを確認して対象プロジェクトを main 最新へ ff 同期する。",
    mode: "headless sonnet (workspace root)",
  },
  "add-as-workflow": {
    label: "カスタムワークフロー登録",
    summary: "投稿内容 (1行目=絵文字、2行目=ラベル、3行目以降=プロンプト) をカスタムワークフローとして JSON に登録する。",
    mode: "headless haiku (Ars workspace)",
  },
  "domain-report": {
    label: "ドメイン情報を投稿",
    summary: "対象プロジェクトのコアドメイン / 層ごとのプログラムドメイン / 層違反を Anatomia から取り、リストとして 1 投稿にまとめて返す。",
    mode: "headless sonnet (スキル domain-review --report-only、cwd = 当該リポ)",
  },
  "domain-review": {
    label: "ドメインレビュー開始",
    summary: "UX とコアドメインの対話レビューを開始する (説明文 / 境界 / UX 直結のレビュー観点を 1 件ずつ問う)。",
    mode: "active へ inject / 非active は headless opus (スキル domain-review)。project_codes.domain_review が OFF なら実行しない",
  },
};

/** 異体字セレクタ / ZWJ / 肌色修飾を含む「絵文字のみ」で構成された文字列か。 */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍)+$/u;

/**
 * 文字列が「単発絵文字」(絵文字のみ、 短い) か。 写像対象アクションの無い単発絵文字を
 * 却下 (プロンプト不通過) するための判定。 通常文・絵文字混じり文は false。
 * Discord ingress / Slack bot の両 ingress が共用する。
 */
export function isStandaloneEmoji(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 32 && EMOJI_ONLY.test(t) && /\p{Extended_Pictographic}/u.test(t);
}

/** 既定の 絵文字→アクション 写像を flat な Record に展開する (GUI 表示・上書きベース)。 */
export function defaultReactionEmojiMap(): Record<string, WorkflowAction> {
  const out: Record<string, WorkflowAction> = {};
  for (const [action, emojis] of Object.entries(WORKFLOW_EMOJI) as [WorkflowAction, readonly string[]][]) {
    for (const e of emojis) out[e] = action;
  }
  return out;
}

/**
 * 絵文字を WorkflowAction に写像する。 該当無しは null (= 記録のみで処理しない)。
 * `overrides` (ユーザ設定の 絵文字→アクション) が既定写像より優先される。
 */
export function classifyReactionWorkflow(
  emoji: string,
  overrides?: Record<string, WorkflowAction>,
): WorkflowAction | null {
  const e = emoji.trim();
  if (isReservedNonActionEmoji(e)) return null;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, e)) {
    return overrides[e] ?? null;
  }
  for (const [action, emojis] of Object.entries(WORKFLOW_EMOJI) as [WorkflowAction, readonly string[]][]) {
    if (emojis.includes(e)) return action;
  }
  return null;
}

/**
 * 発火時にトリガー元メッセージへ出す「受付」通知の文言。
 * 例: 「🙏 残作業の洗い出しを受け付けました」。 文言は各 platform で共通。
 */
export function reactionAckText(action: WorkflowAction, emoji: string): string {
  const label = WORKFLOW_ACTION_HELP[action]?.label ?? action;
  return `${emoji} ${label}を受け付けました`;
}

/**
 * 組み込みのまま残すアクションの実行計画 (設計 §11.1)。
 *
 * プロンプトを流すアクションは Castra のスキル (SKILL.md /
 * commands/*.md) へ移設済みで、 本文はもうここに無い (§11.2 の 2)。
 * それらは Runner が「絵文字 → スキル」エントリを引いて
 * `planSkillWorkflow` で組み立てる。 ここに残るのは Cc API 直叩き /
 * CR 送信の組み込み 4 種と、 スキルを解決できなかったときの fail-safe だけ。
 */
export function planWorkflow(
  action: WorkflowAction,
  ctx: WorkflowContext,
  models: WorkflowModels = DEFAULT_WORKFLOW_MODELS,
): WorkflowPlan {
  void ctx;
  void models;
  switch (action) {
    case "force-enter":
      // 対象 session に CR だけ inject して「Enter 送信」を強制する。 headless は不要。
      return { action, mode: "inject", prompt: ENTER_KEY_TEXT };
    case "context":
      // Runner が read-model port で先に答える。 read model が無い構成では
      // スキル `context-report` の inject 経路へ落ちる。
      return { action, mode: "inject", prompt: "現在のコンテキスト残量を報告してください。" };
    default:
      // channel-rename / submit-pr / list-local-prs は handle() が API を直接呼ぶ。
      // それ以外 (スキルへ移設済み) は本文を持たない — 空プロンプトは
      // 「スキルが解決できなかった」印として Runner が拾う。
      return { action, mode: "headless", prompt: "" };
  }
}

/**
 * 組み込み写像 (`WORKFLOW_EMOJI`) を seed に「絵文字 → スキル」エントリを作り、
 * customWorkflows JSON へ書き出す (設計 §11.2 の 2、
 * `POST /v1/reaction-workflow/migrate-builtin` の実体)。
 *
 * 割り当ての正本はスキル側 frontmatter の `metadata.rwf`。 自由プロンプトの
 * エントリ (add-as-workflow で登録したもの) は消さずに残す。
 */
export async function migrateBuiltinWorkflowsToSkills(input: {
  workspaceRoot: string;
  catalog: readonly SkillCatalogEntry[];
  /** 保存先の上書き (未指定なら workspaceRoot から解決)。 */
  customWorkflowsPath?: string;
}): Promise<SkillWorkflowSeed & { path: string }> {
  const path = input.customWorkflowsPath ?? resolveCustomWorkflowsPath(input.workspaceRoot);
  const seed = buildSkillWorkflowSeed({
    catalog: input.catalog,
    builtinEmoji: WORKFLOW_EMOJI,
    isReservedEmoji: isReservedNonActionEmoji,
  });
  await updateCustomWorkflows(path, (existing) => mergeSkillEntries(existing, seed.entries));
  return { ...seed, path };
}

// ─── Runner ──────────────────────────────────────────────────────────────

/**
 * スキルカタログ (`.claude/skills` / `.claude/commands`) の参照口 (設計 §10.2 C-8)。
 * engine は走査そのものを知らない — ホスト側が `SkillCatalogStore` を注入する。
 */
export interface RwfSkillCatalogPort {
  list: () => readonly SkillCatalogEntry[];
  find: (name: string) => SkillCatalogEntry | null;
  readBody: (entry: SkillCatalogEntry) => Promise<string | null>;
}

export interface ReactionWorkflowDeps {
  /** headless 実行関数 (既定 runClaude)。 テストで差し替え可能。 */
  runHeadless: (prompt: string, opts?: RwfRunOptions) => Promise<RwfRunResult>;
  /**
   * 対象セッションへ文字列を inject する (eventBus.emit("session.inject") 相当)。
   * engine を Concordia 内部 (events) から切り離すため、 ホスト側が実装を注入する。
   */
  emitInject: SessionInjectEmitter;
  /** 🧠 context の read-model port。未配線時は明示的に unavailable を返す。 */
  contextReport?: (sessionId: string) => Promise<string>;
  /**
   * スキルカタログ (`.claude/skills` / `.claude/commands`) の参照口 (設計 §10.2 C-8)。
   * 「絵文字 → スキル」エントリの本文 (headless に渡すシステム文脈) と割り当て宣言を
   * ここから引く。 未注入ならスキル種別のエントリは実行できず、 理由を返す。
   */
  skills?: RwfSkillCatalogPort;
  /**
   * `project_codes.domain_review` の解決 (🪬 の OFF 判定、 設計 §9.2)。
   * "unknown" = 列が無い / 未登録 — 判定できないときは止めない (列の投入順に依存しない)。
   */
  domainReviewEnabled?: (repoPath: string | null) => boolean | "unknown";
  /** ワークスペースルート (= Memoria 等のローカルクローン親)。 単一指定の後方互換。 */
  workspaceRoot: string;
  /** Concordia の HTTP エンドポイント。 channel-rename 等の API 直接呼び出しに使う。 */
  concordiaUrl?: string;
  /**
   * 📋 list-local-prs / 📮 submit-pr / 🔀 merge-pr の実体 (Revisor local PR の一覧・提出・マージ)。 エンジンは
   * Revisor も社員名簿も知らないので、 ホスト側が実装を注入する。 未注入なら PR 操作は
   * 実行せず、 その旨を理由として返す (無言スキップにしない)。
   */
  prOperations?: RwfPrOperations;
  /**
   * 発火者がその操作を実行できるか。 リアクション自体は誰でも押せるが、 中身が
   * セッション起動やマージを要求するなら改めて役職を問う (neco 2026-08-01)。
   * 未注入なら、 権限を要求するアクションは deny (fail-closed)。
   */
  hasCapability?: (userId: string, capability: StaffCapability) => boolean;
  /**
   * この runtime が子会社 Bot か (本社 = false/未指定)。 本社限定アクション
   * (Memoria 記録系の既定 + 設定 GUI の上書き) を子会社で遮断するのに使う。
   */
  subsidiary?: boolean;
  /** アクション別ポリシー (設定 GUI) の live 解決。 未注入は既定のみで判定する。 */
  resolveActionPolicies?: () => WorkflowActionPolicies;
  /**
   * 複数ワークスペースルート (走査対象の全ルート)。 Memoria はこのうち実在する
   * `<root>/Memoria` を採用する。 未指定なら [workspaceRoot] 相当。
   */
  workspaceRoots?: string[];
  /** Memoria リポの cwd override。 未指定なら各ルートから探索 (無ければ先頭ルート/Memoria)。 */
  memoriaPath?: string;
  /**
   * add-as-workflow が書き込み / handle() が読み込むカスタムワークフロー JSON のパス。
   * 未指定なら `<workspaceRoot>/.claude/custom-reaction-workflows.json`。
   */
  customWorkflowsPath?: string;
  /**
   * 安全弁。 false の間は handle() が即 return。 関数を渡すと毎回評価するので、
   * 設定 GUI (AdminState) からの ON/OFF をプロセス再起動なしで反映できる。
   */
  enabled: boolean | (() => boolean);
  models?: WorkflowModels;
  /**
   * ユーザ設定の 絵文字→アクション 上書き写像を返す (設定 GUI / AdminState 由来)。
   * 毎回評価するので再起動なしで反映される。 未指定なら既定写像のみ。
   */
  customMappings?: () => Record<string, WorkflowAction>;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** テスト用時刻プロバイダ。 */
  now?: () => number;
}

/**
 * リアクションWF の入力。 呼び出し側 (Discord/Slack の bot) が、 リアクションされた
 * メッセージ本文と文脈をプラットフォーム API から解決して渡す。
 * chat_messages / message-map には依存しない。発火面の制限は platform ingress が担う。
 */
export interface ReactionWorkflowInput {
  /** 再発火抑制の安定キー (プラットフォームの message id)。 */
  dedupeKey: string;
  /** リアクション絵文字 (unicode)。 */
  emoji: string;
  /** リアクションを付けたユーザ id。 */
  userId: string;
  /** 対象メッセージ本文 (プラットフォーム API から取得)。 残作業系は未使用なので空でも可。 */
  messageText: string;
  /** メッセージ投稿者の表示名。 */
  authorLabel: string;
  /** 対象メッセージのチャンネルに紐づく session の作業ディレクトリ。 無ければ null。 */
  repoPath: string | null;
  /** その session が active か (inject 可否)。 */
  sessionActive: boolean;
  /** inject 先 session id。 session チャンネルでなければ null。 */
  sessionId: string | null;
  /**
   * 発火元のプラットフォーム。 注入された指示の出所 (provenance) に載せる。
   * 未指定なら provenance を付けない (既存の呼び出しを壊さない)。
   */
  platform?: "discord" | "slack";
  /** 発火元の platform-native message ID。dedupe key とは分離して監査照合に使う。 */
  sourceMessageId?: string;
}

export interface WorkflowResultRelay {
  ok: boolean;
  text: string;
}

/** 同一 (dedupeKey, emoji, userId) の再発火を抑える cooldown。 */
const DEDUPE_SEC = 5 * 60;

export class ReactionWorkflowRunner {
  private readonly lastFired = new Map<string, number>();

  constructor(private readonly deps: ReactionWorkflowDeps) {}

  private nowSec(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  private isEnabled(): boolean {
    const e = this.deps.enabled;
    return typeof e === "function" ? e() : e;
  }

  private async memoriaPath(): Promise<string> {
    if (this.deps.memoriaPath) return this.deps.memoriaPath;
    const roots = this.deps.workspaceRoots?.length
      ? this.deps.workspaceRoots
      : [this.deps.workspaceRoot];
    // 各ルートから実在する <root>/Memoria を採用。 無ければ先頭ルート/Memoria。
    for (const root of roots) {
      if (!root) continue;
      const candidate = join(root, "Memoria");
      if (await pathExists(candidate)) return candidate;
    }
    return join(roots[0] || this.deps.workspaceRoot, "Memoria");
  }

  private customWorkflowsPath(): string {
    // 設定 API (reaction-skill-workflows) と同じ解決を通す — 書いた先と読む先が
    // ずれると、 設定画面で保存した割り当てが発火しない。
    return this.deps.customWorkflowsPath ?? resolveCustomWorkflowsPath(this.deps.workspaceRoot);
  }

  /**
   * カスタムワークフロー JSON を読み込む (エラー時は空配列)。
   * @implements spec/feature/reaction-workflow.md §1 — 予約絵文字の custom workflow 遮断
   */
  private async loadCustomWorkflows(): Promise<CustomWorkflowEntry[]> {
    return readCustomWorkflows(this.customWorkflowsPath());
  }

  /**
   * 自由プロンプト種別のカスタムワークフローで絵文字を照合する (スキル種別は
   * `matchSkillEntry` が先に引く)。 ヒットすれば headless 実行計画を返す。
   */
  private matchPromptWorkflow(
    entries: readonly CustomWorkflowEntry[],
    emoji: string,
  ): WorkflowPlan | null {
    const entry = entries.find(
      (e) => !isSkillWorkflowEntry(e) && e.emoji.trim() === emoji.trim(),
    );
    if (!entry || isSkillWorkflowEntry(entry)) return null;
    return {
      action: "add-as-workflow", // プレースホルダー (ログ用)
      mode: "headless",
      model: entry.model ?? "sonnet",
      cwd: entry.cwd ?? undefined,
      prompt: entry.prompt,
    };
  }

  /**
   * 組み込み写像を seed に「絵文字 → スキル」エントリを作り、 JSON へ書き出す
   * (設計 §11.2 の 2)。 実体は module 関数 — 設定 API からも Runner 抜きで呼べる。
   */
  async migrateBuiltinToSkills(): Promise<SkillWorkflowSeed & { path: string }> {
    const result = await migrateBuiltinWorkflowsToSkills({
      workspaceRoot: this.deps.workspaceRoot,
      catalog: this.deps.skills?.list() ?? [],
      customWorkflowsPath: this.customWorkflowsPath(),
    });
    this.deps.log.info(
      `reaction-workflow: migrate-builtin wrote ${result.entries.length} skill entries ` +
      `(uncovered=${result.uncovered.length}) to ${result.path}`,
    );
    return result;
  }

  /**
   * スキルエントリから実行計画を組む。 headless は SKILL.md 本文が要るので、
   * カタログが引けない / 本文が読めない場合は理由を返す (無言スキップにしない)。
   */
  private async planForSkillEntry(
    entry: CustomSkillWorkflowEntry,
    action: WorkflowAction,
    ctx: WorkflowContext,
  ): Promise<{ ok: true; plan: WorkflowPlan } | { ok: false; detail: string }> {
    const catalogEntry = this.deps.skills?.find(entry.skill) ?? null;
    const needsBody = entry.mode === "headless" || !ctx.sessionActive;
    let body: string | null = null;
    if (needsBody) {
      if (!catalogEntry) {
        return {
          ok: false,
          detail: `スキル "${entry.skill}" がスキル一覧に見つかりません (.claude/skills または .claude/commands を確認してください)`,
        };
      }
      body = await this.deps.skills!.readBody(catalogEntry);
    }
    const planned = planSkillWorkflow({
      entry,
      action,
      ctx,
      skillBody: body,
      skillPath: catalogEntry?.path ?? null,
      models: this.deps.models ?? DEFAULT_WORKFLOW_MODELS,
    });
    return planned.ok ? { ok: true, plan: planned.plan } : { ok: false, detail: planned.detail };
  }

  /**
   * reactions.ts から呼ぶ入口。 例外は内部で握り潰す (リアクション記録は壊さない)。
   * `onAccept` は「実際に発火が確定した」直後 (= dedup 通過後、 slow な inject/headless の前) に
   * 一度だけ呼ばれる。 platform 側が「受付」通知を即時に投稿するためのフック。
   * @implements spec/feature/reaction-workflow.md §1 — 予約絵文字を全実行経路より前で遮断
   */
  async handle(
    input: ReactionWorkflowInput,
    onAccept?: (action: WorkflowAction) => void,
    onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
  ): Promise<void> {
    if (!this.isEnabled()) return;
    // 👌 は誤ダブルタップで送られるため、override と JSON custom workflow より先に遮断する。
    if (isReservedNonActionEmoji(input.emoji)) return;

    // 「絵文字 → スキル」エントリを先に引き、 残った組み込みだけ従来分岐へ落とす
    // (設計 §11.2 の 2)。 管理設定の 絵文字→action 上書きは従来どおり効き、
    // 上書き先が移設済みアクションなら action からスキルエントリを辿る。
    const entries = await this.loadCustomWorkflows();
    const skillEntry = matchSkillEntry(entries, input.emoji);
    const builtinAction = classifyReactionWorkflow(input.emoji);
    const action = skillEntry
      // 組み込み絵文字の action は capability 判定の正本。永続 JSON が手編集されても、
      // skill entry の action で権限を弱められないよう canonical action を優先する。
      ? (builtinAction ?? skillEntry.action)
      : classifyReactionWorkflow(input.emoji, this.deps.customMappings?.());

    // 組み込み写像にもスキルにも無い絵文字を、 自由プロンプトの JSON で照合する。
    if (!action) {
      const customPlan = this.matchPromptWorkflow(entries, input.emoji);
      if (!customPlan) return; // どちらにも該当しない絵文字
      const key = `${input.dedupeKey}|${input.emoji}|${input.userId}`;
      const now = this.nowSec();
      const last = this.lastFired.get(key);
      if (last !== undefined && now - last < DEDUPE_SEC) {
        this.deps.log.info(`reaction-workflow: dedup skip (custom) ${key}`);
        return;
      }
      this.lastFired.set(key, now);
      if (onAccept) try { onAccept("add-as-workflow"); } catch { /* best-effort */ }
      this.deps.log.info(
        `reaction-workflow: custom action emoji=${input.emoji} model=${customPlan.model ?? "-"} cwd=${customPlan.cwd ?? "-"}`,
      );
      await this.runHeadless(customPlan).catch((e) =>
        this.deps.log.warn(`reaction-workflow: custom failed: ${(e as Error).message}`),
      );
      return;
    }

    const policies = this.deps.resolveActionPolicies?.() ?? {};
    // 本社限定アクションは子会社 runtime では実行しない (2026-09-02 neco 指示)。
    // 例: Memoria への記録は子会社メンバーから読めないため、押しても意味が無い。
    if (this.deps.subsidiary && !workflowActionSubsidiaryAllowed(action, policies)) {
      // 子会社では「そもそも発火しない」= 対応外の絵文字と同じ扱いにする
      // (2026-09-02 neco 指示)。 返信もせず、監査用のログだけ残す。
      this.deps.log.info(`reaction-workflow: skipped (hq-only) action=${action} user=${input.userId}`);
      return;
    }

    // リアクションは誰でも押せるが、 指示の内容が実行できるとは限らない。 セッション起動や
    // マージを要求するアクションはここで役職を問う (neco 2026-08-01)。 dedup より先に見るのは、
    // 拒否された発火で cooldown を消費させないため — 権限が付いた直後に押し直せる。
    const requiredCapability = workflowActionCapability(action, policies);
    if (requiredCapability) {
      const allowed = this.deps.hasCapability?.(input.userId, requiredCapability) === true;
      if (!allowed) {
        // 拒否は必ず記録する (監査用)。 発火側の cooldown は焼かない。
        this.deps.log.info(
          `reaction-workflow: denied action=${action} user=${input.userId} needs=${requiredCapability}`,
        );
        // 黙って無視しない。 押した本人に何が足りないかを返す。 ただし通知だけは別枠の
        // cooldown で間引く — リアクションは付け外しが自由なので、 毎回返すと拒否された
        // 側が chat を埋め尽くせてしまう。 発火用の key とは名前空間を分けてあるので、
        // 役職が付いた直後の押し直しは従来どおり即座に通る。
        const denyKey = `deny|${input.dedupeKey}|${input.emoji}|${input.userId}`;
        const denyNow = this.nowSec();
        const lastDenied = this.lastFired.get(denyKey);
        const notified = lastDenied !== undefined && denyNow - lastDenied < DEDUPE_SEC;
        if (!notified) {
          this.lastFired.set(denyKey, denyNow);
          const message = workflowDenialMessage(action, requiredCapability);
          if (onResult) try { onResult(action, { ok: false, text: message }); } catch { /* best-effort */ }
        }
        return;
      }
    }

    const key = `${input.dedupeKey}|${input.emoji}|${input.userId}`;
    const now = this.nowSec();
    const last = this.lastFired.get(key);
    if (last !== undefined && now - last < DEDUPE_SEC) {
      this.deps.log.info(`reaction-workflow: dedup skip ${key}`);
      return;
    }
    this.lastFired.set(key, now);

    // 発火確定 → platform 側へ即時通知 (slow な inject/headless を待たせない)。
    // merge-pr は「local PR を試す → 無ければ GitHub 経路へ続行」と 2 段になるので、
    // 二重通知しないよう 1 度だけ発火する形にまとめる。
    let accepted = false;
    const notifyAccept = (): void => {
      if (accepted || !onAccept) return;
      accepted = true;
      try {
        onAccept(action);
      } catch (e) {
        this.deps.log.warn(`reaction-workflow: onAccept failed: ${(e as Error).message}`);
      }
    };

    // channel-rename: headless/inject ではなく Concordia API を直接呼ぶ。
    // 🧠 context: read model が使えるならそれが先 (LLM を起動しない)。 使えない構成では
    // スキル `context-report` の inject 経路へ落とす (READ_MODEL_FIRST_ACTIONS)。
    if (READ_MODEL_FIRST_ACTIONS.has(action) && input.sessionId && this.deps.contextReport) {
      notifyAccept();
      try {
        onResult?.(action, { ok: true, text: await this.deps.contextReport(input.sessionId) });
      } catch (error) {
        this.deps.log.warn(`reaction-workflow: context failed: ${(error as Error).message}`);
        onResult?.(action, { ok: false, text: `コンテキスト推定に失敗しました: ${(error as Error).message}` });
      }
      return;
    }

    // channel-rename: headless/inject ではなく Concordia API を直接呼ぶ。
    if (action === "channel-rename") {
      notifyAccept();
      await this.handleChannelRename(input);
      return;
    }

    // 📮 submit-pr: Revisor local PR の提出。 headless/inject は経由しない。
    if (action === "submit-pr") {
      notifyAccept();
      await this.handleSubmitPr(input, onResult);
      return;
    }

    // 📋 list-local-prs: Revisor local PR の一覧。 読み取り専用の API 直呼びで、
    // セッションチャンネルでなくても発火できる (その場合は全リポジトリ)。
    if (action === "list-local-prs") {
      notifyAccept();
      await this.handleListLocalPrs(input, onResult);
      return;
    }

    // 🔀 merge-pr: 既定は Revisor local PR のマージ。 open な local PR が無いときだけ
    // 従来の GitHub squash merge 経路 (プロンプト) へ落とす。 どちらを実行したかは
    // handleMergePr が必ず応答に出す。
    if (action === "merge-pr") {
      notifyAccept();
      const handledByLocalPr = await this.handleMergePr(input, onResult);
      if (handledByLocalPr) return;
    }

    // 文脈は呼び出し側 (Discord/Slack bot) がプラットフォーム API で解決済。
    // chat_messages / message-map には依存しない。
    const ctx: WorkflowContext = {
      messageText: input.messageText,
      authorLabel: input.authorLabel,
      repoPath: input.repoPath,
      sessionActive: input.sessionActive,
      memoriaPath: await this.memoriaPath(),
      reactorId: input.userId,
      workspaceRoot: this.deps.workspaceRoot,
    };
    // 🪬 ドメインレビューはプロジェクト設定で OFF にできる (設計 §9.2)。 📑 の投稿は止めない。
    if (action === DOMAIN_REVIEW_ACTION && this.deps.domainReviewEnabled?.(input.repoPath) === false) {
      notifyAccept();
      this.deps.log.info(`reaction-workflow: domain-review skipped (project setting OFF) repo=${input.repoPath ?? "-"}`);
      this.relayPrResult(
        action,
        false,
        "このプロジェクトはドメインレビューが設定 OFF です (/projects の domain_review を ON にしてください)。",
        onResult,
      );
      return;
    }

    // スキル種別のエントリがあればそれを実行する。 絵文字からは引けなくても、
    // 管理設定の上書きで移設済みアクションに着地した場合は action から引き直す。
    const resolvedSkillEntry = skillEntry ?? findSkillEntryForAction(entries, action);
    let plan: WorkflowPlan;
    if (resolvedSkillEntry) {
      const planned = await this.planForSkillEntry(resolvedSkillEntry, action, ctx);
      if (!planned.ok) {
        notifyAccept();
        this.deps.log.warn(`reaction-workflow: skill plan failed action=${action}: ${planned.detail}`);
        this.relayPrResult(action, false, planned.detail, onResult);
        return;
      }
      plan = planned.plan;
    } else {
      plan = planWorkflow(action, ctx, this.deps.models ?? DEFAULT_WORKFLOW_MODELS);
      if (!BUILTIN_ONLY_ACTIONS.has(action) && !plan.prompt) {
        // 移設済みなのにスキル割り当てが無い = 取りこぼし。 黙って何もしない代わりに
        // 何が足りないかを返す (`POST /v1/reaction-workflow/migrate-builtin` で復旧できる)。
        notifyAccept();
        const detail =
          `${input.emoji} (${action}) にスキルが割り当てられていません。` +
          ` 設定 > リアクションWF の「スキル割り当て」で登録するか、` +
          ` POST /v1/reaction-workflow/migrate-builtin を実行してください。`;
        this.deps.log.warn(`reaction-workflow: no skill entry for migrated action=${action}`);
        this.relayPrResult(action, false, detail, onResult);
        return;
      }
    }

    this.deps.log.info(
      `reaction-workflow: action=${action} mode=${plan.mode} model=${plan.model ?? "-"} ` +
      `cwd=${plan.cwd ?? "-"} dedupeKey=${input.dedupeKey} emoji=${input.emoji}`,
    );

    notifyAccept();

    try {
      if (plan.mode === "inject") {
        this.inject(input.sessionId, plan.prompt, action, buildProvenance(input, action));
      } else {
        const result = await this.runHeadless(plan);
        this.relayHeadlessResult(action, result, onResult);
      }
    } catch (e) {
      this.deps.log.warn(`reaction-workflow: action=${action} failed: ${(e as Error).message}`);
      this.relayHeadlessResult(action, {
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: (e as Error).message,
        duration_ms: 0,
      }, onResult);
    }
  }

  /** PR 操作の結果を発火元へ返す。 相手が居ない構成でも例外にしない。 */
  private relayPrResult(
    action: WorkflowAction,
    ok: boolean,
    text: string,
    onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
  ): void {
    if (!onResult) return;
    try {
      onResult(action, { ok, text });
    } catch (e) {
      this.deps.log.warn(`reaction-workflow: pr result relay failed: ${(e as Error).message}`);
    }
  }

  /**
   * 📮 submit-pr — 対象セッションの作業ブランチを Revisor local PR として提出する。
   * 提出しなかった場合も理由を返す (無言スキップ禁止)。 実行者は必ずログに残す。
   */
  private async handleSubmitPr(
    input: ReactionWorkflowInput,
    onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
  ): Promise<void> {
    const actor = { userId: input.userId };
    if (!input.sessionId) {
      this.deps.log.warn("reaction-workflow: submit-pr skipped (no sessionId — not a session channel)");
      this.relayPrResult("submit-pr", false, describePrSubmitOutcome(
        { ok: false, kind: "unavailable", reason: "no_session" },
        actor,
      ), onResult);
      return;
    }
    if (!this.deps.prOperations) {
      this.deps.log.warn("reaction-workflow: submit-pr skipped (prOperations not injected)");
      this.relayPrResult("submit-pr", false, describePrSubmitOutcome(
        { ok: false, kind: "unavailable", reason: "operations_unavailable" },
        actor,
      ), onResult);
      return;
    }
    try {
      const outcome = await this.deps.prOperations.submitLocalPr({ sessionId: input.sessionId, actor });
      this.deps.log.info(
        `reaction-workflow: submit-pr session=${input.sessionId.slice(0, 8)} actor=${input.userId} ` +
        `kind=${outcome.kind}${outcome.ok ? "" : ` reason=${outcome.reason}`}`,
      );
      this.relayPrResult("submit-pr", outcome.ok, describePrSubmitOutcome(outcome, actor), onResult);
    } catch (e) {
      const detail = (e as Error).message;
      this.deps.log.warn(`reaction-workflow: submit-pr failed: ${detail}`);
      this.relayPrResult("submit-pr", false, describePrSubmitOutcome(
        { ok: false, kind: "skipped", reason: "error", detail },
        actor,
      ), onResult);
    }
  }

  /**
   * 📋 list-local-prs — Revisor local PR の一覧を返す。 読み取り専用なので権限判定は
   * 通らない。 出せなかった場合も理由を返す (無言スキップ禁止)。
   */
  private async handleListLocalPrs(
    input: ReactionWorkflowInput,
    onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
  ): Promise<void> {
    const actor = { userId: input.userId };
    const listLocalPrs = this.deps.prOperations?.listLocalPrs?.bind(this.deps.prOperations);
    if (!listLocalPrs) {
      this.deps.log.warn("reaction-workflow: list-local-prs skipped (listLocalPrs not injected)");
      this.relayPrResult("list-local-prs", false, describePrListOutcome(
        { ok: false, kind: "unavailable", detail: "local PR 一覧経路がこの構成では有効になっていません" },
        actor,
      ), onResult);
      return;
    }
    try {
      const outcome = await listLocalPrs({ sessionId: input.sessionId, actor });
      this.deps.log.info(
        `reaction-workflow: list-local-prs session=${input.sessionId?.slice(0, 8) ?? "-"} ` +
        `actor=${input.userId} ok=${outcome.ok}${outcome.ok ? ` open=${outcome.openCount}` : ""}`,
      );
      this.relayPrResult("list-local-prs", outcome.ok, describePrListOutcome(outcome, actor), onResult);
    } catch (e) {
      const errorKind = e instanceof Error ? e.name : "unknown";
      this.deps.log.warn(`reaction-workflow: list-local-prs failed (${errorKind})`);
      this.relayPrResult("list-local-prs", false, describePrListOutcome(
        { ok: false, kind: "unavailable", detail: "一覧処理中にエラーが発生しました" },
        actor,
      ), onResult);
    }
  }

  /**
   * 🔀 merge-pr の既定経路 — セッションが提出した open な Revisor local PR をマージする。
   *
   * 戻り値 true = ここで決着した (マージ済 / 権限不足 / マージ失敗)。 false = local PR が
   * 無いので呼び出し側が従来の GitHub squash merge 経路へ落とす。 どちらの場合も
   * 「どちらを実行するのか」を必ず応答に出す。
   */
  private async handleMergePr(
    input: ReactionWorkflowInput,
    onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
  ): Promise<boolean> {
    const actor = { userId: input.userId };
    if (!input.sessionId) {
      this.deps.log.info("reaction-workflow: merge-pr local PR route skipped (no sessionId) → GitHub fallback");
      this.relayPrResult("merge-pr", true, describeMergeFallback({
        ok: false,
        kind: "unavailable",
        detail: "リアクション先がセッションチャンネルではないため、対象の local PR を特定できません",
      }), onResult);
      return false;
    }
    if (!this.deps.prOperations) {
      this.deps.log.info("reaction-workflow: merge-pr local PR route skipped (prOperations not injected) → GitHub fallback");
      this.relayPrResult("merge-pr", true, describeMergeFallback({
        ok: false,
        kind: "unavailable",
        detail: "local PR のマージ経路がこの構成では有効になっていません",
      }), onResult);
      return false;
    }

    let outcome;
    try {
      outcome = await this.deps.prOperations.mergeLocalPr({ sessionId: input.sessionId, actor });
    } catch (e) {
      const detail = (e as Error).message;
      this.deps.log.warn(`reaction-workflow: merge-pr local PR merge failed: ${detail}`);
      this.relayPrResult("merge-pr", false, describePrMergeOutcome({ ok: false, kind: "failed", detail }, actor), onResult);
      return true;
    }

    this.deps.log.info(
      `reaction-workflow: merge-pr session=${input.sessionId.slice(0, 8)} actor=${input.userId} kind=${outcome.kind}`,
    );
    if (outcome.kind === "no_local_pr" || outcome.kind === "unavailable") {
      // 経路を落とすこと自体を必ず伝える。 落ちた先 (GitHub 経路) は呼び出し側が実行する。
      this.relayPrResult("merge-pr", true, describeMergeFallback(outcome), onResult);
      return false;
    }
    // 権限不足はフォールバックしない — 権限の無い人が GitHub 経路で押し通せてはいけない。
    this.relayPrResult("merge-pr", outcome.ok, describePrMergeOutcome(outcome, actor), onResult);
    return true;
  }

  private async handleChannelRename(input: ReactionWorkflowInput): Promise<void> {
    if (!input.sessionId) {
      this.deps.log.warn("reaction-workflow: channel-rename skipped (no sessionId — not a session channel)");
      return;
    }
    const text = input.messageText.trim().slice(0, 200);
    if (!text) {
      this.deps.log.warn("reaction-workflow: channel-rename skipped (empty message text)");
      return;
    }
    const baseUrl = this.deps.concordiaUrl ?? "http://127.0.0.1:11111";
    try {
      const res = await fetch(`${baseUrl}/v1/sessions/${input.sessionId}/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source: "reaction-rename" }),
      });
      if (!res.ok) {
        this.deps.log.warn(
          `reaction-workflow: channel-rename API failed session=${input.sessionId.slice(0, 8)} status=${res.status}`,
        );
      } else {
        this.deps.log.info(
          `reaction-workflow: channel-rename applied session=${input.sessionId.slice(0, 8)} text="${text.slice(0, 40)}"`,
        );
      }
    } catch (e) {
      this.deps.log.warn(`reaction-workflow: channel-rename fetch failed: ${(e as Error).message}`);
    }
  }

  private inject(
    targetSessionId: string | null,
    text: string,
    action: WorkflowAction,
    provenance?: InjectionProvenance,
  ): void {
    if (!targetSessionId) {
      this.deps.log.warn(`reaction-workflow: ${action} inject skipped (no session_id)`);
      return;
    }
    const injectedText = provenance
      ? `【Concordia reaction-workflow: ${provenance.action} (${provenance.platform})】\n${text}`
      : text;
    this.deps.emitInject(targetSessionId, injectedText, REACTION_WORKFLOW_SOURCE, provenance);
    this.deps.log.info(`reaction-workflow: injected ${action} into session ${targetSessionId.slice(0, 8)}`);
  }

  private async runHeadless(plan: WorkflowPlan): Promise<RwfRunResult> {
    const r = await this.deps.runHeadless(plan.prompt, {
      model: plan.model,
      cwd: plan.cwd,
      dangerouslySkipPermissions: true,
    });
    if (r.ok) {
      this.deps.log.info(`reaction-workflow: ${plan.action} headless ok (${r.duration_ms}ms)`);
    } else {
      this.deps.log.warn(
        `reaction-workflow: ${plan.action} headless failed exit=${r.exit_code}: ${r.stderr.slice(0, 300)}`,
      );
    }
    return r;
  }

  private relayHeadlessResult(
    action: WorkflowAction,
    result: RwfRunResult,
    onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
  ): void {
    if (!onResult || !shouldRelayHeadlessResult(action)) return;
    const raw = result.ok ? result.stdout.trim() : (result.stderr.trim() || `exit=${result.exit_code ?? "unknown"}`);
    const text = raw || (result.ok ? "完了しました。" : "失敗しました。");
    try {
      onResult(action, { ok: result.ok, text: clipWorkflowRelayText(text) });
    } catch (e) {
      this.deps.log.warn(`reaction-workflow: result relay failed: ${(e as Error).message}`);
    }
  }
}

function shouldRelayHeadlessResult(action: WorkflowAction): boolean {
  // merge-pr は GitHub 経路へ落ちたときの実行結果まで返す (フォールバック先の顛末を隠さない)。
  return action === "handoff-document" || action === "merge-pr";
}

function clipWorkflowRelayText(text: string, max = 1800): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 40).trimEnd()}\n\n...(truncated; see session-logs for full handoff)`;
}

/**
 * 注入の出所を組み立てる。 platform が渡っていなければ付けない — 出所を
 * 名乗れないなら黙って付けるより、 従来どおり user 扱いにするほうが誤解が少ない。
 */
function buildProvenance(
  input: ReactionWorkflowInput,
  action: WorkflowAction,
): InjectionProvenance | undefined {
  if (!input.platform) return undefined;
  return {
    kind: "reaction-workflow",
    action,
    platform: input.platform,
    emoji: input.emoji,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    actorId: input.userId,
  };
}
