/**
 * リアクションワークフロー — chat メッセージへのリアクションを「指示」として解釈し、
 * 種類に応じた処理を headless claude (`claude -p --model …`) / session.inject で実行する。
 *
 * 設計 (spec/feature/reaction-workflow.md):
 *  - reactions.ts が reaction 記録後に handle() を呼ぶ。
 *  - リアクション絵文字 → WorkflowAction に写像 (classifyReactionWorkflow)。
 *  - 実処理は「LLM が解析 + 記録/着手まで」を 1 ショットで担う:
 *      start-impl       👍 / 🆗   良い → 提案をそのまま実装着手 (authoring session へ inject、
 *                                 非 active なら headless で着手)
 *      repo-memory-good 😄        良い動き → 当該リポの作業メモリにメッセージ+結果を記録 (haiku)
 *      memoria-note     👀        気になる結果 → Memoria にメモを記録 (haiku)
 *      memoria-task     📝 / ✅   残作業 → タスク内容を確認して Memoria にタスク登録 (sonnet)
 *      repo-memory-bad  😡 / 👎   良くない → リポ作業メモリに行動結果を記録 (haiku)
 *
 * 安全弁: 既定 OFF。 enabled (CONCORDIA_REACTION_WORKFLOW=1) の時だけ実処理を走らせる。
 * headless 実行は file 書き込み / Memoria 連携を伴うので dangerouslySkipPermissions で起動する
 * (ローカル信頼自動化前提、 error-autofix と同じ運用思想)。
 */

import { join } from "node:path";
import type { ChatRepo, ChatMessageRow } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { RunClaudeOptions, ClaudeRunResult } from "../rules/claude-runner.js";
import { eventBus } from "../events.js";

export type WorkflowAction =
  | "start-impl"
  | "repo-memory-good"
  | "repo-memory-bad"
  | "memoria-note"
  | "memoria-task";

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
  // 良い動き → リポ作業メモリに記録 (smile 系)
  "repo-memory-good": ["😄", "😀", "😃", "😊", "🙂", "😁"],
  // 気になる結果 → Memoria メモ (eye 系)
  "memoria-note": ["👀", "👁️", "👁"],
  // 残作業 → Memoria タスク (Note / check 系)
  "memoria-task": ["📝", "📓", "🗒️", "🗒", "✏️", "✏", "✅", "☑️", "✔️", "✔"],
  // 良くない動き → リポ作業メモリに記録 (rage / bad 系)
  "repo-memory-bad": ["😡", "💢", "👿", "😠", "👎"],
};

/** 絵文字を WorkflowAction に写像する。 該当無しは null (= 記録のみで処理しない)。 */
export function classifyReactionWorkflow(emoji: string): WorkflowAction | null {
  const e = emoji.trim();
  for (const [action, emojis] of Object.entries(WORKFLOW_EMOJI) as [WorkflowAction, readonly string[]][]) {
    if (emojis.includes(e)) return action;
  }
  return null;
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

  switch (action) {
    case "start-impl": {
      const prompt =
        `👍 このメッセージ (直前の提案 / 計画) が承認されました。 提案内容を**そのまま実装に着手**してください。\n` +
        `- 余計な再確認はせず、 提案された方針で実装を開始する。\n` +
        `- LUDIARS 規約 (ブランチ → 実装 → コミット → PR、 自動マージ可) に従う。\n` +
        `- 提案に曖昧な点があっても、 最も素直な解釈で進めてよい。`;
      // authoring session が生きていれば、 その AI に inject して文脈ごと続行させる。
      if (ctx.sessionActive) {
        return { action, mode: "inject", prompt };
      }
      // 非 active: headless で repo を開いて着手する。
      return {
        action,
        mode: "headless",
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
        head +
        `\n😡 これは「良くない実装/行動」と評価されました。\n` +
        `**このリポジトリの作業メモリ**に、 「どんなメッセージ・行動だったか」と「なぜ良くなかったか/その結果」を ` +
        `1 エントリとして簡潔に追記して保存してください。\n` +
        `- 既存の作業メモリの場所・形式を踏襲する。\n` +
        `- 後で「避けるべきパターン」として参照できる粒度で書く。`;
      return {
        action,
        mode: "headless",
        model: models.haiku,
        cwd: ctx.repoPath ?? undefined,
        prompt,
      };
    }

    case "memoria-note": {
      const prompt =
        head +
        `\n👀 これは「気になる結果」として共有されました。\n` +
        `内容を解析し、 **Memoria にメモとして記録**してください (Memoria のメモ/ノート機能 or 相応の relay 経路)。\n` +
        `- 何が気になるのか / 後で見返すべき要点を 1〜3 行に要約してメモ化する。\n` +
        `- 出所として「Concordia リアクション (👀) 由来」「投稿者: ${ctx.authorLabel}」を残す。`;
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
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────

export interface ReactionWorkflowDeps {
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  /** headless 実行関数 (既定 runClaude)。 テストで差し替え可能。 */
  runHeadless: (prompt: string, opts?: RunClaudeOptions) => Promise<ClaudeRunResult>;
  /** ワークスペースルート (= Memoria 等のローカルクローン親)。 */
  workspaceRoot: string;
  /** Memoria リポの cwd override。 未指定で join(workspaceRoot, "Memoria")。 */
  memoriaPath?: string;
  /** false の間は handle() が即 return (安全弁)。 */
  enabled: boolean;
  models?: WorkflowModels;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** テスト用時刻プロバイダ。 */
  now?: () => number;
}

export interface ReactionWorkflowInput {
  /** chat_messages.id (reactions.ts が逆引き済)。 */
  chatId: number;
  /** Discord 絵文字文字列 (reaction.emoji.name)。 */
  emoji: string;
  /** リアクションを付けた Discord user id。 */
  userId: string;
}

/** 同一 (chatId, emoji, userId) の再発火を抑える cooldown。 */
const DEDUPE_SEC = 5 * 60;

export class ReactionWorkflowRunner {
  private readonly lastFired = new Map<string, number>();

  constructor(private readonly deps: ReactionWorkflowDeps) {}

  private nowSec(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  private memoriaPath(): string {
    return this.deps.memoriaPath ?? join(this.deps.workspaceRoot, "Memoria");
  }

  /** reactions.ts から呼ぶ入口。 例外は内部で握り潰す (リアクション記録は壊さない)。 */
  async handle(input: ReactionWorkflowInput): Promise<void> {
    if (!this.deps.enabled) return;

    const action = classifyReactionWorkflow(input.emoji);
    if (!action) return; // ワークフロー対象外の絵文字

    const key = `${input.chatId}|${input.emoji}|${input.userId}`;
    const now = this.nowSec();
    const last = this.lastFired.get(key);
    if (last !== undefined && now - last < DEDUPE_SEC) {
      this.deps.log.info(`reaction-workflow: dedup skip ${key}`);
      return;
    }
    this.lastFired.set(key, now);

    const msg = this.deps.chatRepo.findById(input.chatId);
    if (!msg) {
      this.deps.log.warn(`reaction-workflow: chat_messages.id=${input.chatId} not found`);
      return;
    }

    const ctx = this.buildContext(msg, input.userId);
    const plan = planWorkflow(action, ctx, this.deps.models ?? DEFAULT_WORKFLOW_MODELS);

    this.deps.log.info(
      `reaction-workflow: action=${action} mode=${plan.mode} model=${plan.model ?? "-"} ` +
      `cwd=${plan.cwd ?? "-"} chatId=${input.chatId} emoji=${input.emoji}`,
    );

    try {
      if (plan.mode === "inject") {
        this.inject(msg.session_id, plan.prompt, action);
      } else {
        await this.runHeadless(plan);
      }
    } catch (e) {
      this.deps.log.warn(`reaction-workflow: action=${action} failed: ${(e as Error).message}`);
    }
  }

  private buildContext(msg: ChatMessageRow, reactorId: string): WorkflowContext {
    let repoPath: string | null = null;
    let sessionActive = false;
    if (msg.session_id) {
      const s = this.deps.sessionsRepo.findSession(msg.session_id);
      if (s) {
        repoPath = s.repo_path;
        sessionActive = s.status === "active";
      }
    }
    return {
      messageText: msg.text,
      authorLabel: msg.author_label,
      repoPath,
      sessionActive,
      memoriaPath: this.memoriaPath(),
      reactorId,
    };
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
