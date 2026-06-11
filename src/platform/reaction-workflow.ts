/**
 * リアクションワークフロー — chat メッセージへのリアクションを「指示」として解釈し、
 * 種類に応じた処理を headless claude (`claude -p --model …`) / session.inject で実行する。
 *
 * 設計 (spec/feature/reaction-workflow.md):
 *  - reactions.ts が reaction 記録後に handle() を呼ぶ。
 *  - リアクション絵文字 → WorkflowAction に写像 (classifyReactionWorkflow)。
 *  - 実処理は「LLM が解析 + 記録/着手まで」を 1 ショットで担う:
 *      start-impl         👍 / 🆗   良い → 提案をそのまま実装着手 (authoring session へ inject、
 *                                   非 active なら headless で着手)
 *      enumerate-remaining 🙏       残作業を洗い出して報告 (authoring session へ inject、
 *                                   非 active なら headless で洗い出し) ←→ 🫶/😴/✨ と対の WF
 *      memoria-remaining  🫶/😴/✨  残作業 (洗い出し結果) を重複回避で Memoria に登録 (memoria-record / sonnet)
 *      status-check       📲/🆙/👆 状況どう? → セッションに今の作業状況を報告させる (inject、
 *                                   非 active なら headless)
 *      repo-memory-good   😄        良い動き → 当該リポの作業メモリにメッセージ+結果を記録 (haiku)
 *      memoria-note       👀/👈/📓/✏️ メッセージをメモに残す → Memoria にメモを記録 (haiku)
 *      memoria-task       📝 / ✅   残作業 → タスク内容を確認して Memoria にタスク登録 (sonnet)
 *      repo-memory-bad    😡 / 👎   良くない → 作業を即中断して反省 (inject、 記録はせず後続 👍 に委ねる)
 *
 * 🙏 → 🫶/😴/✨ は「残作業洗い出し → Memoria 記録」の 2 段リアクションワークフロー。 まず 🙏 で
 * セッションに残作業を洗い出させ、 その洗い出し結果メッセージに 🫶/😴/✨ を付けると Memoria へ記録する。
 *
 * 安全弁: 既定 OFF。 enabled (CONCORDIA_REACTION_WORKFLOW=1) の時だけ実処理を走らせる。
 * headless 実行は file 書き込み / Memoria 連携を伴うので dangerouslySkipPermissions で起動する
 * (ローカル信頼自動化前提、 error-autofix と同じ運用思想)。
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { RunClaudeOptions, ClaudeRunResult } from "../rules/claude-runner.js";
import { eventBus } from "../events.js";

export type WorkflowAction =
  | "start-impl"
  | "enumerate-remaining"
  | "memoria-remaining"
  | "status-check"
  | "repo-memory-good"
  | "repo-memory-bad"
  | "memoria-note"
  | "memoria-task"
  | "defer-impl"
  | "force-enter"
  | "delegate-task";

/**
 * リアクション絵文字 → WorkflowAction。 Discord は標準絵文字を unicode 文字 (👍 等) で、
 * `reaction.emoji.name` に渡してくる。 ここでは unicode 文字で照合する。
 *
 * 注意: discord-repo.classifyEmoji (fine/bad/raw 記録用) とは別系統。 ワークフロールータは
 * 「ok=🆗 → 着手」「check=✅ → 残作業タスク」のように細かく分岐する。
 */
const WORKFLOW_EMOJI: Record<WorkflowAction, readonly string[]> = {
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
  // Enter を強制送信 (Lictor が送信を取りこぼした時の救済。 対象 session へ \n を inject)
  "force-enter": ["🙄"],
  // delegation に対応する絵文字 → Haiku でタスク判定 → タスクあり = delegation invoke
  "delegate-task": ["🤝", "🫱", "🫱🏻", "🫱🏼", "🫱🏽", "🫱🏾", "🫱🏿"],
};

/** 全 WorkflowAction の一覧 (API / GUI の検証・選択肢に使う)。 */
export const WORKFLOW_ACTIONS = Object.keys(WORKFLOW_EMOJI) as WorkflowAction[];

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
    summary: "投稿内容を変換せず、 対象 session に \\n を inject して送信を強制する (Lictor が Enter を取りこぼした時の救済)。",
    mode: "active セッションへ inject のみ (非 active はスキップ)",
  },
  "delegate-task": {
    label: "タスク委託実行",
    summary: "投稿内容を『Haiku でタスク判定 → タスクあり = 最適な delegation template を選んで invoke、なし = スキップ』に変換して渡す。",
    mode: "active へ inject (委託+監視) / 非active は headless haiku (委託のみ)",
  },
};

/** action 文字列が有効な WorkflowAction か。 */
export function isWorkflowAction(v: unknown): v is WorkflowAction {
  return typeof v === "string" && (WORKFLOW_ACTIONS as string[]).includes(v);
}

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

/** プロンプト組み立て / 実行手段の決定に渡す文脈。 */
export interface WorkflowContext {
  /** リアクションされた chat メッセージ本文。 */
  messageText: string;
  /** メッセージの投稿者ラベル (AI role 名 / human 名)。 */
  authorLabel: string;
  /** メッセージを書いた session の作業ディレクトリ (リポ)。 null = 不明。 */
  repoPath: string | null;
  /** authoring session が今も active か。 start-impl の inject 可否判定に使う。 */
  sessionActive: boolean;
  /** Memoria リポの作業ディレクトリ (memoria-note / memoria-task の cwd)。 */
  memoriaPath: string;
  /** リアクションを付けたユーザの Discord ID (記録の出所明示用)。 */
  reactorId: string;
}

export type WorkflowMode = "inject" | "headless";

/** action ごとの実行計画。 mode=inject は authoring session への session.inject。 */
export interface WorkflowPlan {
  action: WorkflowAction;
  mode: WorkflowMode;
  /** headless 時の `--model`。 inject では無視。 */
  model?: string;
  /** headless 時の cwd。 inject では無視。 */
  cwd?: string;
  /** inject / headless いずれの本文。 */
  prompt: string;
}

/** モデル別名 (env 上書き可)。 CLI alias で渡し、 バージョン追従は CLI 側に委ねる。 */
export interface WorkflowModels {
  /** memoria-note / repo-memory に使う軽量モデル。 */
  haiku: string;
  /** memoria-task (内容確認 + 登録) に使う中位モデル。 */
  sonnet: string;
}

export const DEFAULT_WORKFLOW_MODELS: WorkflowModels = {
  haiku: process.env.CONCORDIA_REACTION_MODEL_HAIKU ?? "haiku",
  sonnet: process.env.CONCORDIA_REACTION_MODEL_SONNET ?? "sonnet",
};

function clip(s: string, n = 4000): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…(truncated)` : t;
}

/** action + 文脈から実行計画 (手段 / モデル / cwd / プロンプト) を構築する (純粋)。 */
export function planWorkflow(
  action: WorkflowAction,
  ctx: WorkflowContext,
  models: WorkflowModels = DEFAULT_WORKFLOW_MODELS,
): WorkflowPlan {
  const msg = clip(ctx.messageText);
  const head =
    `# リアクションワークフロー\n` +
    `あなたは Concordia から起動された 1 ショットの自動エージェントです。 以下の作業を完了したら終了してください。 余計な対話・確認はしません。\n\n` +
    `- 対象メッセージ投稿者: ${ctx.authorLabel}\n` +
    `- 対象メッセージ本文:\n"""\n${msg}\n"""\n`;
  // inject 経路 (authoring session へ流す) でも、 トリガとなった投稿内容を変換して必ず渡す。
  // 対象セッションが文脈を持っていても「どの発言に対する指示か」を明示するため。
  const msgRef = `\n\n--- 対象メッセージ (${ctx.authorLabel}) ---\n"""\n${msg}\n"""`;

  switch (action) {
    case "start-impl": {
      const prompt =
        `👍 このメッセージ (直前の提案 / 計画) が承認されました。 提案内容を**そのまま実装に着手**してください。\n` +
        `- 余計な再確認はせず、 提案された方針で実装を開始する。\n` +
        `- LUDIARS 規約 (ブランチ → 実装 → コミット → PR、 自動マージ可) に従う。\n` +
        `- 提案に曖昧な点があっても、 最も素直な解釈で進めてよい。\n` +
        `- ただし対象が直前の「反省」(😡/👎 由来) なら、 この 👍 は実装着手ではなく ` +
        `「その反省を“避けるべきパターン”として当該リポの作業メモリに記録せよ」という承認である。`;
      // authoring session が生きていれば、 その AI に inject して文脈ごと続行させる。
      if (ctx.sessionActive) {
        return { action, mode: "inject", prompt: prompt + msgRef };
      }
      // 非 active: headless で repo を開いて着手する。
      return {
        action,
        mode: "headless",
        cwd: ctx.repoPath ?? undefined,
        prompt: head + "\n" + prompt,
      };
    }

    case "enumerate-remaining": {
      const prompt =
        `🙏 このメッセージ (直前の作業 / 報告) を起点に、 **今やり残している残作業を洗い出して報告**してください。\n` +
        `- 着手中の作業・未完了のタスク・TODO・既知の課題を、 重複なくリスト形式で列挙する。\n` +
        `- 各項目は「何を / どこまで終わっていて / 次に何をすべきか」が分かる粒度で 1 行ずつ書く。\n` +
        `- 推測で水増しせず、 実際に残っているものだけを挙げる。 無ければ「残作業なし」と明記する。\n` +
        `- この洗い出し結果は後段で 🫶/😴/✨ リアクションにより Memoria へ残作業として記録される前提で、 そのまま転記できる形にする。`;
      // authoring session が生きていれば、 その AI に inject して文脈ごと洗い出させる。
      if (ctx.sessionActive) {
        return { action, mode: "inject", prompt: prompt + msgRef };
      }
      // 非 active: headless で repo を開いて洗い出す。
      return {
        action,
        mode: "headless",
        model: models.sonnet,
        cwd: ctx.repoPath ?? undefined,
        prompt: head + "\n" + prompt,
      };
    }

    case "memoria-remaining": {
      // memoria-record ワークフロー (洗い出し結果 → 重複回避で Memoria 登録)。 中身は環境依存の
      // スラッシュコマンドに頼らず Concordia が自前で保持する (headless claude へそのまま渡す)。
      const prompt =
        head +
        `\n🫶 これは「残作業の洗い出し結果」です (🙏 の後段、 memoria-record ワークフロー)。\n` +
        `列挙された残作業を **重複を避けて Memoria に登録**してください。\n` +
        `1. 既存タスクを取得して突き合わせる (Memoria の \`GET /api/tasks?limit=200\`、 既定 base http://127.0.0.1:5180)。\n` +
        `2. メッセージ本文の各残作業から「タスク名 (title) / 完了条件・対象リポ等 (details)」を読み取る。 既存タスクと同義のものは登録しない。\n` +
        `3. 新規ぶんを Memoria のタスクとして登録する。 PowerShell/curl の日本語文字化けを避けるため、 memoria-task スキルの Node スクリプトを使う:\n` +
        `   \`node <Memoria>/../.claude/skills/memoria-task/post-tasks.mjs <tasks.json>\` (配列 or { "tasks": [...] }、 creator_type は ai 付与)。 当該スクリプトが無い環境では \`POST /api/tasks\` を直接叩く。\n` +
        `4. 推測で水増しせず、 実際に残っている項目だけを登録する。 出所として「Concordia リアクション (🫶/😴/✨ / memoria-record) 由来」「投稿者: ${ctx.authorLabel}」を details に残す。\n` +
        `- Memoria に繋がらない場合は中断せず、 未登録の残作業と失敗理由を報告する。`;
      return {
        action,
        mode: "headless",
        model: models.sonnet,
        cwd: ctx.memoriaPath,
        prompt,
      };
    }

    case "status-check": {
      const prompt =
        `📲 状況どう?\n` +
        `今やっている作業の**現在の状況を報告**してください。\n` +
        `- 着手中のタスク / どこまで進んだか / 今ブロックしている点 / 次の一手 を簡潔にまとめる。\n` +
        `- 進捗が無いなら「待機中」「手詰まり (理由)」など正直な状態を書く。 体裁のための水増しはしない。`;
      // authoring session が生きていれば、 その AI に inject して現状を報告させる。
      if (ctx.sessionActive) {
        return { action, mode: "inject", prompt: prompt + msgRef };
      }
      // 非 active: headless で repo を開いて状況を報告する。
      return {
        action,
        mode: "headless",
        model: models.sonnet,
        cwd: ctx.repoPath ?? undefined,
        prompt: head + "\n" + prompt,
      };
    }

    case "repo-memory-good": {
      const prompt =
        head +
        `\n😄 これは「良い動きをした実装/行動」と評価されました。\n` +
        `**このリポジトリの作業メモリ** (このリポが使っている memory / CLAUDE 系の記録先) に、 ` +
        `「どんなメッセージ・行動だったか」と「その結果」を 1 エントリとして簡潔に追記して保存してください。\n` +
        `- 既存の作業メモリの場所・形式を踏襲する (無ければ作業メモリ用の md を作る)。\n` +
        `- 後で「うまくいったパターン」として参照できる粒度で書く。`;
      return {
        action,
        mode: "headless",
        model: models.haiku,
        cwd: ctx.repoPath ?? undefined,
        prompt,
      };
    }

    case "repo-memory-bad": {
      const prompt =
        `😡 この作業は「良くない」と評価されました。\n` +
        `1. まず**今やっている作業を直ちに中断**してください (これ以上進めない・コミットしない)。\n` +
        `2. 次に、 何が良くなかったか / なぜそうなったか / どう変えるべきかを**反省**として簡潔にまとめて報告する。\n` +
        `3. この時点では**メモリに記録しない**。 記録の要否は後続のユーザ操作に委ねる: ` +
        `この反省に 👍 が付いたら「避けるべきパターン」としてこのリポの作業メモリに記録する。 付かなければ記録しない。`;
      // 中断は走っている本人にしかできない。 active なら inject、 非 active は headless で反省のみ。
      if (ctx.sessionActive) {
        return { action, mode: "inject", prompt: prompt + msgRef };
      }
      return {
        action,
        mode: "headless",
        model: models.haiku,
        cwd: ctx.repoPath ?? undefined,
        prompt: head + "\n" + prompt,
      };
    }

    case "memoria-note": {
      const prompt =
        head +
        `\n📓 これは「メモに残しておきたいメッセージ」として共有されました。\n` +
        `**Memoria にメモとして記録**してください (Memoria のメモ/ノート機能 or 相応の relay 経路)。\n` +
        `- メッセージ本文を**そのまま (原文のまま、 要約・改変せず)** メモ本文として記録する。\n` +
        `- 出所として「Concordia リアクション (👀/👈/📓/✏️) 由来」「投稿者: ${ctx.authorLabel}」を残す。`;
      return {
        action,
        mode: "headless",
        model: models.haiku,
        cwd: ctx.memoriaPath,
        prompt,
      };
    }

    case "memoria-task": {
      const prompt =
        head +
        `\n📝 これは「残作業」として共有されました。\n` +
        `内容を解析して**何をすべきタスクなのかを確定**し、 **Memoria にタスクとして登録**してください。\n` +
        `- メッセージから「タスク名 / 完了条件 / 対象リポ」を読み取り、 曖昧なら最も妥当な形に整える。\n` +
        `- Memoria のタスク機能 (or 相応の relay 経路) に 1 件登録する。\n` +
        `- 出所として「Concordia リアクション (📝/✅) 由来」「投稿者: ${ctx.authorLabel}」を残す。`;
      return {
        action,
        mode: "headless",
        model: models.sonnet,
        cwd: ctx.memoriaPath,
        prompt,
      };
    }

    case "force-enter": {
      // 対象 session に \n だけ inject して「Enter 送信」を強制する。 headless は不要 (session が
      // 存在しない = 送る相手がいない)。 session.inject はテキスト経由なので \n を渡す。
      return { action, mode: "inject", prompt: "\n" };
    }

    case "delegate-task": {
      // Haiku 分類 → タスクあり = delegation invoke。 inject 経路では authoring session に
      // 「委託 + 監視」まで担わせる。 headless 経路では委託のみ (監視先 session が無い)。
      const delegateInstructions =
        `🤝 このメッセージにタスク委託のリアクションが付きました。以下を順番に実行してください:\n\n` +
        `**ステップ 1: タスク判定 (Haiku レベルの軽量分類)**\n` +
        `メッセージに「実行すべき具体的なタスク」が含まれているか判断してください。\n` +
        `- 含まれない (感想/質問/状態報告のみ) → 「委託タスクなし — スキップ」として即終了。\n` +
        `- 含まれる → ステップ 2 へ。\n\n` +
        `**ステップ 2: テンプレート選択 & 委託**\n` +
        `1. GET http://127.0.0.1:17330/v1/delegation/templates で利用可能なテンプレートを取得。\n` +
        `2. メッセージ内容に最適なテンプレートを選択する (task-process / impl-from-design / fix-bug / refactor 等)。\n` +
        `3. GET http://127.0.0.1:17330/v1/spawn/info で spawn token のパスを確認し、読み取る。\n` +
        `4. POST http://127.0.0.1:17330/v1/delegation/invoke で委託:\n` +
        `   { "call_name": "<選んだテンプレート>", "args": { ... }, "triggered_by": "reaction-workflow-delegate" }\n` +
        `   Authorization: Bearer <spawn token>\n` +
        `5. run ID と spawn_pid を取得して報告する。`;
      const monitorNote = ctx.sessionActive
        ? `\n\n委託後は起動した Lictor プロセスの完了を監視し、結果を報告してください。`
        : `\n\nセッションが非 active のため監視は行わない。委託のみ実行して終了する。`;

      if (ctx.sessionActive) {
        return {
          action,
          mode: "inject",
          prompt: delegateInstructions + monitorNote + msgRef,
        };
      }
      return {
        action,
        mode: "headless",
        model: models.haiku,
        cwd: ctx.repoPath ?? undefined,
        prompt: head + "\n" + delegateInstructions + monitorNote,
      };
    }

    case "defer-impl": {
      const prompt =
        head +
        `\n⏭️ これは「実装タスクを積んで別セッションへ委ねる」指示です。\n` +
        `メッセージから**実装タスク**を抽出し、 **Memoria にタスクとして登録**してください。\n` +
        `- メッセージ本文に含まれる実装タスクを 1 件以上読み取り、 各タスクの「タスク名 / 完了条件 / 対象リポ」を整える。\n` +
        `- 各タスクの details に「別セッションで対応」という旨と出所「Concordia リアクション (⏭️/📤/🗂️) 由来、 投稿者: ${ctx.authorLabel}」を残す。\n` +
        `- Memoria のタスク機能 (or 相応の relay 経路) に登録する。 PowerShell/curl の日本語文字化けを避けるため、 memoria-task スキルの Node スクリプトを使う:\n` +
        `  \`node <Memoria>/../.claude/skills/memoria-task/post-tasks.mjs <tasks.json>\` (配列 or { "tasks": [...] }、 creator_type は ai 付与)。 当該スクリプトが無い環境では \`POST /api/tasks\` を直接叩く。\n` +
        `- Memoria に繋がらない場合は中断せず、 未登録タスクと失敗理由を報告する。`;
      return {
        action,
        mode: "headless",
        model: models.sonnet,
        cwd: ctx.memoriaPath,
        prompt,
      };
    }
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────

export interface ReactionWorkflowDeps {
  /** headless 実行関数 (既定 runClaude)。 テストで差し替え可能。 */
  runHeadless: (prompt: string, opts?: RunClaudeOptions) => Promise<ClaudeRunResult>;
  /** ワークスペースルート (= Memoria 等のローカルクローン親)。 単一指定の後方互換。 */
  workspaceRoot: string;
  /**
   * 複数ワークスペースルート (走査対象の全ルート)。 Memoria はこのうち実在する
   * `<root>/Memoria` を採用する。 未指定なら [workspaceRoot] 相当。
   */
  workspaceRoots?: string[];
  /** Memoria リポの cwd override。 未指定なら各ルートから探索 (無ければ先頭ルート/Memoria)。 */
  memoriaPath?: string;
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
 * chat_messages / message-map には依存しない (= どのメッセージに付いても発火する)。
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

  private memoriaPath(): string {
    if (this.deps.memoriaPath) return this.deps.memoriaPath;
    const roots = this.deps.workspaceRoots?.length
      ? this.deps.workspaceRoots
      : [this.deps.workspaceRoot];
    // 各ルートから実在する <root>/Memoria を採用。 無ければ先頭ルート/Memoria。
    for (const root of roots) {
      if (!root) continue;
      const candidate = join(root, "Memoria");
      if (existsSync(candidate)) return candidate;
    }
    return join(roots[0] || this.deps.workspaceRoot, "Memoria");
  }

  /**
   * reactions.ts から呼ぶ入口。 例外は内部で握り潰す (リアクション記録は壊さない)。
   * `onAccept` は「実際に発火が確定した」直後 (= dedup 通過後、 slow な inject/headless の前) に
   * 一度だけ呼ばれる。 platform 側が「受付」通知を即時に投稿するためのフック。
   */
  async handle(
    input: ReactionWorkflowInput,
    onAccept?: (action: WorkflowAction) => void,
  ): Promise<void> {
    if (!this.isEnabled()) return;

    const action = classifyReactionWorkflow(input.emoji, this.deps.customMappings?.());
    if (!action) return; // ワークフロー対象外の絵文字

    const key = `${input.dedupeKey}|${input.emoji}|${input.userId}`;
    const now = this.nowSec();
    const last = this.lastFired.get(key);
    if (last !== undefined && now - last < DEDUPE_SEC) {
      this.deps.log.info(`reaction-workflow: dedup skip ${key}`);
      return;
    }
    this.lastFired.set(key, now);

    // 文脈は呼び出し側 (Discord/Slack bot) がプラットフォーム API で解決済。
    // chat_messages / message-map には依存しない。
    const ctx: WorkflowContext = {
      messageText: input.messageText,
      authorLabel: input.authorLabel,
      repoPath: input.repoPath,
      sessionActive: input.sessionActive,
      memoriaPath: this.memoriaPath(),
      reactorId: input.userId,
    };
    const plan = planWorkflow(action, ctx, this.deps.models ?? DEFAULT_WORKFLOW_MODELS);

    this.deps.log.info(
      `reaction-workflow: action=${action} mode=${plan.mode} model=${plan.model ?? "-"} ` +
      `cwd=${plan.cwd ?? "-"} dedupeKey=${input.dedupeKey} emoji=${input.emoji}`,
    );

    // 発火確定 → platform 側へ即時通知 (slow な inject/headless を待たせない)。
    if (onAccept) {
      try {
        onAccept(action);
      } catch (e) {
        this.deps.log.warn(`reaction-workflow: onAccept failed: ${(e as Error).message}`);
      }
    }

    try {
      if (plan.mode === "inject") {
        this.inject(input.sessionId, plan.prompt, action);
      } else {
        await this.runHeadless(plan);
      }
    } catch (e) {
      this.deps.log.warn(`reaction-workflow: action=${action} failed: ${(e as Error).message}`);
    }
  }

  private inject(targetSessionId: string | null, text: string, action: WorkflowAction): void {
    if (!targetSessionId) {
      this.deps.log.warn(`reaction-workflow: ${action} inject skipped (no session_id)`);
      return;
    }
    eventBus.emit({
      type: "session.inject",
      target_session_id: targetSessionId,
      text,
      source: "reaction-workflow",
      ts: this.nowSec(),
    });
    this.deps.log.info(`reaction-workflow: injected ${action} into session ${targetSessionId.slice(0, 8)}`);
  }

  private async runHeadless(plan: WorkflowPlan): Promise<void> {
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
  }
}
