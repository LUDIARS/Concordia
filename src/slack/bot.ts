// Slack platform 実装（ChatPlatform）。Socket Mode で接続し（Concordia は
// loopback-only で inbound URL を持てないため Events API ではなく Socket Mode）、
// eventBus を購読してセッション出力を Slack に中継、Slack 側の入力を Concordia
// HTTP API に戻す。v0.1 は設定した 1 チャンネル内 thread-per-session 方式。
// spec/feature/slack-platform.md が正本。

import type { Database } from "better-sqlite3";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import type { ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SlackConfigRepo } from "../db/slack-config-repo.js";
import { upsertCostCanvas, type CostCanvasClient } from "./cost-canvas.js";
import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { formatAuthorName } from "../platform/formatter.js";
import { reportError, looksLikeFailure } from "../errors.js";
import type { ChatPlatform } from "../platform/chat-platform.js";
import { WorkingIndicator } from "../platform/working-indicator.js";
import { ENTER_KEY_TEXT } from "../control/enter-key.js";
import { makeSlackSessionThreadsRepo } from "./session-threads-repo.js";
import { makeSlackMessageMapRepo } from "./message-map-repo.js";
import { readSlackEnv, slackEnvReady, readSlackChatMeta, type SlackEnv } from "./types.js";
import { wrapTablesInCode } from "../shared/message-blocks.js";
import {
  buildQuestionBlocks,
  buildSessionBotUsername,
  extractRelayableFrame,
  parseAnswerActionId,
  sanitizeSlackMentions,
  truncateForSlack,
  renderSessionCard,
  extractMonologue,
  slackReactionToUnicode,
  deriveTitleFromPost,
  parseOtherAnswerActionId,
  type SessionCardState,
} from "./render.js";
import { runSlackSlash, spawnSession, subFromCoCommand, listDelegationTemplates, invokeDelegation } from "./slash.js";
import {
  buildDelegationModalView,
  parseDelegationModalSubmit,
  parseDelegationSelectAction,
  reconcileDelegationArgs,
  DELEGATION_MODAL_CALLBACK_ID,
  PROMPT_BLOCK,
  type WorkdirOption,
} from "./delegation-modal.js";
import { type WorkflowAction } from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import { runClaude } from "../rules/claude-runner.js";

const slackLog = createChildLogger("slack");
const QUESTION_OTHER_MODAL_CALLBACK_ID = "concordia_question_other";
const QUESTION_OTHER_BLOCK = "question_other_block";
const QUESTION_OTHER_ACTION = "question_other_text";
const log = {
  info: (m: string) => slackLog.info(m),
  warn: (m: string) => {
    slackLog.warn(m);
    if (looksLikeFailure(m)) reportError("slack", m);
  },
  error: (m: string) => {
    slackLog.error(m);
    reportError("slack", m);
  },
};

export interface SlackBotDeps {
  db: Database;
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  personasRepo: PersonasRepo;
  /** cost Canvas の canvas_id 永続化に使う key/value repo (slack_config)。 */
  slackConfigRepo: SlackConfigRepo;
  concordiaUrl: string;
  /** test 用に env を直接差し替えるための injection（最優先）。 */
  env?: SlackEnv;
  /**
   * サービス内設定 (DB + env フォールバック) からの実効設定リゾルバ。
   * start のたびに呼ぶので、 設定変更後に restart すれば新しい値で再接続される。
   * 未指定なら env のみ (readSlackEnv)。
   */
  resolveConfig?: () => SlackEnv;
  /** リアクションワークフロー (👍 → 実装着手 等) の Memoria 解決用ワークスペースルート。 */
  workspaceRoot?: string;
  /** 設定 GUI (AdminState) で上書き可能な workspaceRoot を bot start 時に live 解決する。 */
  resolveWorkspaceRoot?: () => string;
  /** 複数ワークスペースルートを bot start 時に live 解決する (Memoria は実在ルートを採用)。 */
  resolveWorkspaceRoots?: () => string[];
  /** リアクションワークフローの安全弁の既定値 (env 由来)。 resolve 未指定時のフォールバック。 */
  reactionWorkflowEnabled?: boolean;
  /** 安全弁を bot 稼働中に live 評価する (設定 GUI トグルを再起動なしで反映)。 */
  resolveReactionWorkflowEnabled?: () => boolean;
  /** ユーザ設定の 絵文字→アクション 上書き写像を live 解決する。 */
  resolveReactionMappings?: () => Record<string, WorkflowAction>;
}

/** 投稿テキストが `:name:` 形式の Slack 絵文字なら unicode に正規化。 それ以外はそのまま。 */
function slackEmojiTextToUnicode(t: string): string {
  const m = t.match(/^:([a-z0-9_+'-]+):$/i);
  if (m) return slackReactionToUnicode(m[1]) ?? t;
  return t;
}

export async function startSlackBot(deps: SlackBotDeps): Promise<ChatPlatform | null> {
  const env = deps.env ?? deps.resolveConfig?.() ?? readSlackEnv();
  if (!env.enabled) {
    log.info("CONCORDIA_SLACK_ENABLED != 1; skip");
    return null;
  }
  if (!slackEnvReady(env)) {
    log.warn("CONCORDIA_SLACK_{BOT_TOKEN,APP_TOKEN,CHANNEL_ID} のいずれかが未設定; skip");
    return null;
  }
  const channelId = env.channelId!;
  const web = new WebClient(env.botToken!);
  const socket = new SocketModeClient({ appToken: env.appToken! });
  const threads = makeSlackSessionThreadsRepo(deps.db);
  const messageMap = makeSlackMessageMapRepo(deps.db);

  // /co-spawn の作業ディレクトリ候補に使うワークスペースルート群を live 解決する。
  const resolveWorkspaceRoots = (): string[] => {
    const multi = deps.resolveWorkspaceRoots?.();
    if (multi && multi.length) return multi;
    const single = deps.resolveWorkspaceRoot?.() || deps.workspaceRoot;
    return single ? [single] : [];
  };

  // リアクションワークフロー (👍=実装着手 / 📝=タスク登録 等)。Discord と同じ
  // platform 非依存ランナーを流用。runner は常に構築し、 安全弁は handle() 内で live 評価
  // (設定 GUI トグルを bot 再起動なしで反映)。
  const reactionWorkflow = new (getRwf().ReactionWorkflowRunner)({
    runHeadless: runClaude,
    emitInject: (sessionId, text, source) =>
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, ts: Math.floor(Date.now() / 1000) }),
    workspaceRoot: deps.resolveWorkspaceRoot?.() || deps.workspaceRoot || process.cwd(),
    workspaceRoots: deps.resolveWorkspaceRoots?.(),
    enabled: deps.resolveReactionWorkflowEnabled ?? (() => deps.reactionWorkflowEnabled ?? false),
    customMappings: deps.resolveReactionMappings,
    log: { info: (m) => log.info(`reaction-workflow: ${m}`), warn: (m) => log.warn(`reaction-workflow: ${m}`) },
  });

  // 自分の bot user id（自分の投稿を ingress で拾わないため）。
  let botUserId: string | null = null;
  try {
    const auth = await web.auth.test();
    botUserId = (auth.user_id as string) ?? null;
  } catch (e) {
    log.warn(`auth.test failed: ${(e as Error).message}`);
  }

  // 同一セッションの thread root を二重作成しないための in-flight ロック。
  const threadInFlight = new Map<string, Promise<string | null>>();

  // ─── egress: session の thread を解決（無ければ root を立てて作る）──────────
  async function ensureSessionThread(sessionId: string): Promise<string | null> {
    const existing = threads.findBySessionId(sessionId);
    if (existing) return existing.thread_ts;
    const inFlight = threadInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const p = (async (): Promise<string | null> => {
      try {
        const cardState = buildCardState(sessionId, "active");
        const card = renderSessionCard(cardState);
        const res = await web.chat.postMessage({
          channel: channelId,
          username: buildSessionBotUsername(cardState),
          text: card.text,
          blocks: card.blocks as never,
        });
        const ts = (res.ts as string) ?? null;
        if (!ts) {
          log.warn(`thread root post returned no ts session=${sessionId}`);
          return null;
        }
        threads.upsert({ session_id: sessionId, channel_id: channelId, thread_ts: ts });
        log.info(`thread root created session=${sessionId} ts=${ts}`);
        return ts;
      } catch (e) {
        log.warn(`thread root post failed session=${sessionId}: ${(e as Error).message}`);
        return null;
      } finally {
        threadInFlight.delete(sessionId);
      }
    })();
    threadInFlight.set(sessionId, p);
    return p;
  }

  // ライブカードの状態を session 行 + persona から組む（同期・純粋寄り）。
  // ended の poem は呼び出し側 (renderEndedCard) が埋める。
  function buildCardState(sessionId: string, status: "active" | "ended", poem?: string | null): SessionCardState {
    const session = deps.sessionsRepo.findSession(sessionId);
    const meta = readMeta(session?.metadata);
    const persona = meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
    const who = formatAuthorName(persona?.display_name ?? null, meta.role_label ?? null);
    return {
      who,
      emoji: meta.delegation_emoji ?? null,
      provider: session?.provider ?? null,
      model: meta.model ?? null,
      currentTask: session?.current_task ?? null,
      shortId: sessionId.slice(0, 8),
      status,
      poem: poem ?? null,
    };
  }

  // thread root（ライブカード）を現在の session 状態で再描画する。persona 割当 /
  // current_task 更新 / title 変更のたびに呼ぶ。root 未作成なら何もしない。
  async function renderRootCard(sessionId: string, status: "active" | "ended" = "active", poem?: string | null): Promise<void> {
    const row = threads.findBySessionId(sessionId);
    if (!row) return;
    try {
      const card = renderSessionCard(buildCardState(sessionId, status, poem));
      await web.chat.update({
        channel: channelId,
        ts: row.thread_ts,
        text: card.text,
        blocks: card.blocks as never,
      });
    } catch (e) {
      log.warn(`root card update failed session=${sessionId}: ${(e as Error).message}`);
    }
  }

  // session.ended: report の独白ポエムを抜いて root カードを「✅ Done + ポエム」に差し替える。
  function renderEndedCard(sessionId: string): void {
    const report = deps.sessionsRepo.findReport(sessionId);
    const poem = extractMonologue(report?.summary_md);
    void renderRootCard(sessionId, "ended", poem).catch((e) =>
      log.warn(`ended card update failed session=${sessionId}: ${(e as Error).message}`),
    );
  }

  // thread に1件投稿し、posted ts を返す（messageMap 登録に使う）。失敗時 null。
  // 中継経路の不具合 (返信が Slack に出ない) を実機で切り分けられるよう、 thread 解決・
  // 投稿成否を info で残す ([verbose-slack-egress] 安定後に撤去予定)。
  async function postToSessionThread(sessionId: string, text: string, author: string): Promise<string | null> {
    const threadTs = await ensureSessionThread(sessionId);
    if (!threadTs) {
      log.warn(`[verbose-slack-egress] postToSessionThread no thread session=${sessionId} (root 作成失敗 → 中継不可)`);
      return null;
    }
    try {
      // テーブルを ``` で囲んで桁ズレを防ぐ (Slack も等幅コードブロックで整列)。
      const sanitized = sanitizeSlackMentions(truncateForSlack(wrapTablesInCode(text), 12000));
      const r = await web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        username: author,
        text: sanitized,
      });
      const ts = (r.ts as string) ?? null;
      log.info(`[verbose-slack-egress] thread relay ok session=${sessionId} thread_ts=${threadTs} ts=${ts ?? "?"} len=${text.length}`);
      return ts;
    } catch (e) {
      log.warn(`postMessage(thread) failed session=${sessionId}: ${(e as Error).message}`);
      return null;
    }
  }

  // 最初のスレッド投稿で /rename 相当を発火し、 親カード（📌）を投稿本文から更新する。
  // current_task が空（= カードがセッション id 先頭8桁にフォールバックしている）ときだけ
  // 発火し、 prompt 由来の実 current_task は上書きしない。 1 セッション 1 回（in-memory）。
  const autoTitledSessions = new Set<string>();
  async function maybeAutoTitleFromFirstPost(sessionId: string, text: string): Promise<void> {
    if (autoTitledSessions.has(sessionId)) return;
    const session = deps.sessionsRepo.findSession(sessionId);
    if (!session) return;
    if ((session.current_task ?? "").trim()) { autoTitledSessions.add(sessionId); return; } // 既に題あり
    const title = deriveTitleFromPost(text);
    if (!title) return;
    autoTitledSessions.add(sessionId); // 二重発火防止（POST 前にマーク）
    try {
      const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(sessionId)}/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: title }),
      });
      if (!res.ok) {
        log.warn(`[verbose-slack-egress] auto-title POST /title failed status=${res.status} session=${sessionId}`);
        autoTitledSessions.delete(sessionId); // 失敗時は再挑戦を許す
        return;
      }
      log.info(`[verbose-slack-egress] auto-title set session=${sessionId} title="${title}"`);
    } catch (e) {
      log.warn(`[verbose-slack-egress] auto-title network error session=${sessionId}: ${(e as Error).message}`);
      autoTitledSessions.delete(sessionId);
    }
  }

  async function handleChatPosted(ev: Extract<ConcordiaEvent, { type: "chat.posted" }>): Promise<void> {
    const row = deps.chatRepo.findById(ev.message_id);
    if (!row) return;
    // Slack ingress 由来の chat は既に Slack 上に表示済 → 自己ループ防止。
    if (readSlackChatMeta(row.metadata).source === "slack") {
      log.info(`chat.posted skipped — source=slack (self-loop) message_id=${row.id}`);
      return;
    }
    const author = row.author_label?.trim() || "Concordia";
    if (row.session_id) {
      log.info(`[verbose-slack-egress] chat.posted → thread session=${row.session_id} message_id=${row.id} channel=${row.channel}`);
      const ts = await postToSessionThread(row.session_id, row.text, author);
      // リアクション逆引き用に ts → chat_messages.id を登録（👍 ワークフローの入口）。
      if (ts) messageMap.put(channelId, ts, row.id);
      // 最初の投稿なら投稿本文からカードのやる事(📌)を起こす（/rename 相当）。
      void maybeAutoTitleFromFirstPost(row.session_id, row.text).catch((e) =>
        log.warn(`auto-title (chat.posted): ${(e as Error).message}`),
      );
      return;
    }
    // セッション非紐付け（chitchat / consultation / 報告 等）はチャンネル直下へ。
    try {
      const r = await web.chat.postMessage({ channel: channelId, text: `*${author}* [${row.channel}]\n${truncateForSlack(row.text, 12000)}` });
      if (typeof r.ts === "string") messageMap.put(channelId, r.ts, row.id);
    } catch (e) {
      log.warn(`postMessage(meta) failed message_id=${row.id}: ${(e as Error).message}`);
    }
  }

  async function handleTranscriptFrame(ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>): Promise<void> {
    const frame = extractRelayableFrame(ev.kind, ev.payload);
    if (!frame) {
      log.info(`[verbose-slack-egress] transcript.frame skipped (non-relayable) session=${ev.target_session_id} kind=${ev.kind}`);
      return;
    }
    const session = deps.sessionsRepo.findSession(ev.target_session_id);
    const meta = readMeta(session?.metadata);
    const persona = frame.role === "assistant" && meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
    const author = frame.role === "summary"
      ? "Conversation summary"
      : formatAuthorName(persona?.display_name ?? null, meta.role_label ?? null);
    log.info(`[verbose-slack-egress] transcript.frame → thread session=${ev.target_session_id} role=${frame.role}`);
    await postToSessionThread(ev.target_session_id, frame.text, author);
    // assistant 本文の最初の1件で /rename 相当（summary は題材にしない）。
    if (frame.role === "assistant") {
      void maybeAutoTitleFromFirstPost(ev.target_session_id, frame.text).catch((e) =>
        log.warn(`auto-title (transcript.frame): ${(e as Error).message}`),
      );
    }
  }

  // question_id → 投稿した質問メッセージの ts。回答/ローカル解決時にボタンを外すため保持。
  // 再起動で消えるが、その場合でも Concordia 側 markAnswered で再クリックは弾かれる。
  const questionMsgTs = new Map<number, string>();

  async function handleQuestionPosted(ev: Extract<ConcordiaEvent, { type: "question.posted" }>): Promise<void> {
    const threadTs = await ensureSessionThread(ev.target_session_id);
    if (!threadTs) return;
    const { text, blocks } = buildQuestionBlocks(ev.question_id, ev.question, ev.options);
    try {
      const r = await web.chat.postMessage({ channel: channelId, thread_ts: threadTs, text, blocks: blocks as never });
      if (typeof r.ts === "string") questionMsgTs.set(ev.question_id, r.ts);
    } catch (e) {
      log.warn(`question post failed session=${ev.target_session_id} qid=${ev.question_id}: ${(e as Error).message}`);
    }
  }

  // 回答済み / ローカル解決時に質問メッセージのボタンを外す（再クリック防止）。
  async function clearQuestionButtons(questionId: number, label: string): Promise<void> {
    const ts = questionMsgTs.get(questionId);
    if (!ts) return;
    questionMsgTs.delete(questionId);
    try {
      await web.chat.update({
        channel: channelId,
        ts,
        text: label,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: label } }] as never,
      });
    } catch (e) {
      log.warn(`clearQuestionButtons failed qid=${questionId}: ${(e as Error).message}`);
    }
  }

  function buildQuestionOtherModal(sessionId: string, questionId: number): Record<string, unknown> {
    return {
      type: "modal",
      callback_id: QUESTION_OTHER_MODAL_CALLBACK_ID,
      private_metadata: JSON.stringify({ session_id: sessionId, question_id: questionId }),
      title: { type: "plain_text", text: "自由入力" },
      submit: { type: "plain_text", text: "送信" },
      close: { type: "plain_text", text: "キャンセル" },
      blocks: [{
        type: "input",
        block_id: QUESTION_OTHER_BLOCK,
        label: { type: "plain_text", text: "回答" },
        element: {
          type: "plain_text_input",
          action_id: QUESTION_OTHER_ACTION,
          multiline: true,
          max_length: 2000,
        },
      }],
    };
  }

  // 「作業中」インジケータ: session thread の最下部に「🔄 作業中…」を出し、進捗で
  // 消して落ち着いたら出し直す。Discord と同じ platform 非依存コントローラを流用し、
  // post/remove だけ Slack thread 用に差す。spec/feature/working-indicator.md
  const idleSec = Math.max(15, Number(process.env.CONCORDIA_SLACK_WORKING_IDLE_SEC ?? "60") || 60);
  const working = new WorkingIndicator({
    idleMs: idleSec * 1000,
    log: (m) => log.info(`working-indicator: ${m}`),
    post: async (sessionId) => {
      const tt = await ensureSessionThread(sessionId);
      if (!tt) return null;
      try {
        const r = await web.chat.postMessage({ channel: channelId, thread_ts: tt, text: "🔄 *作業中…*" });
        return (r.ts as string) ?? null;
      } catch (e) {
        log.warn(`working post failed session=${sessionId}: ${(e as Error).message}`);
        return null;
      }
    },
    remove: async (_sessionId, ts) => {
      try { await web.chat.delete({ channel: channelId, ts }); } catch { /* best-effort */ }
    },
  });

  // Slack user id → 表示名 のキャッシュ (users.info の呼び出し回数を抑える)。
  const slackNameCache = new Map<string, string>();
  async function resolveSlackName(userId: string): Promise<string> {
    if (!userId) return "Slack user";
    const cached = slackNameCache.get(userId);
    if (cached) return cached;
    try {
      const r = await web.users.info({ user: userId });
      const p = (r.user as { profile?: { display_name?: string; real_name?: string }; name?: string } | undefined);
      const name = p?.profile?.display_name?.trim() || p?.profile?.real_name?.trim() || p?.name || userId;
      slackNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  // 相手PF(Discord)由来の inject を Slack の該当 session thread に発言者付きで転記。
  // Slack 由来は元発言が thread に既出のため転記しない。制御 inject は ^discord: に
  // 一致せず除外。
  async function mirrorForeignInject(ev: Extract<ConcordiaEvent, { type: "session.inject" }>): Promise<void> {
    const src = ev.source ?? "";
    if (!src.startsWith("discord:")) return;
    const threadTs = await ensureSessionThread(ev.target_session_id);
    if (!threadTs) return;
    const who = ev.author_label?.trim() || "Discord user";
    await web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🔁 *Discord / ${who}*\n${truncateForSlack(ev.text, 12000)}`,
    });
  }

  const unsubscribe = eventBus.subscribe((ev) => {
    if (ev.type === "session.started") {
      // セッション起動の瞬間に thread root（ライブカード）を立てる。これが無いと
      // 最初の relay 発言まで Slack には何も出ず「起動したのに無反応」に見える。
      // session.ended のポエム上書き（renderEndedCard）も親カードの存在が前提。
      void ensureSessionThread(ev.session_id).catch((e) =>
        log.warn(`session.started thread root: ${(e as Error).message}`),
      );
    } else if (ev.type === "chat.posted") {
      void handleChatPosted(ev).catch((e) => log.warn(`chat.posted dispatch: ${(e as Error).message}`));
      if (ev.session_id) working.noteProgress(ev.session_id);
    } else if (ev.type === "transcript.frame") {
      void handleTranscriptFrame(ev).catch((e) => log.warn(`transcript.frame dispatch: ${(e as Error).message}`));
      working.noteProgress(ev.target_session_id);
    } else if (ev.type === "question.posted") {
      void handleQuestionPosted(ev).catch((e) => log.warn(`question.posted dispatch: ${(e as Error).message}`));
    } else if (ev.type === "question.answered") {
      void clearQuestionButtons(ev.question_id, `✅ *回答済み* — 選択肢 ${ev.answer_index + 1}`);
    } else if (ev.type === "question.resolved") {
      void clearQuestionButtons(ev.question_id, "✅ *回答済み（ローカル）*");
    } else if (ev.type === "session.inject") {
      // 環境同期: 相手PF(Discord)由来の inject を Slack thread にも発言者付きで転記。
      void mirrorForeignInject(ev).catch((e) => log.warn(`session.inject mirror: ${(e as Error).message}`));
    } else if (ev.type === "session.event" && ev.kind === "prompt") {
      working.noteProgress(ev.session_id);
    } else if (ev.type === "session.event" && (ev.kind === "title_renamed" || ev.kind === "task_update")) {
      // current_task / title が変わったら親カード（使用AI + 現在の作業内容）を再描画。
      void renderRootCard(ev.session_id).catch((e) => log.warn(`root card reflect: ${(e as Error).message}`));
    } else if (ev.type === "persona.assigned") {
      // persona 割当でカードの「使用AI/担当」表示を更新。
      void renderRootCard(ev.session_id).catch((e) => log.warn(`root card persona: ${(e as Error).message}`));
    } else if (ev.type === "report.generated") {
      // report 確定後にポエムが入るので、終了カードを最終形へ再描画。
      renderEndedCard(ev.session_id);
    } else if (ev.type === "session.ended") {
      working.clear(ev.session_id);
      threads.setStatus(ev.session_id, "ended");
      // 終了の瞬間に Done 化（ポエムは report.generated で後追い差し替え）。
      renderEndedCard(ev.session_id);
    } else if (ev.type === "session.lost") {
      working.clear(ev.session_id);
    }
  });

  // ─── ingress: Slack message → Concordia inject / chat ──────────────────────
  socket.on("message", async ({ event, ack }: { event: SlackMessageEvent; ack: () => Promise<void> }) => {
    try { await ack(); } catch {}
    try {
      if (!event || event.type !== "message") return;
      if (event.subtype) return; // edits / joins / bot_message 等は無視
      if (event.bot_id) return;
      if (botUserId && event.user === botUserId) return;
      if (event.channel !== channelId) return;
      const text = (event.text ?? "").trim();
      if (!text || text.startsWith("//")) return;

      // 単発で投稿された絵文字 (🙏 / 🫡 等) は「直近メッセージへのリアクション」と同義に扱い、
      // inject/chat には載せずリアクションワークフローへ流す (Discord ingress と同じ挙動)。
      const wfEmoji = slackEmojiTextToUnicode(text);
      if (getRwf().classifyReactionWorkflow(wfEmoji, deps.resolveReactionMappings?.())) {
        // 対象 chat_messages: thread 返信ならその session の直近、 チャンネル直下なら
        // consultation メタチャットの直近メッセージ。
        let target: { id: number; text: string; author_label: string; session_id: string | null } | null = null;
        if (event.thread_ts && event.thread_ts !== event.ts) {
          const row = threads.findByThreadTs(channelId, event.thread_ts);
          if (row) target = deps.chatRepo.latestForSession(row.session_id) ?? null;
        } else {
          target = deps.chatRepo.list({ channel: "consultation", limit: 1 })[0] ?? null;
        }
        if (target != null) {
          // 対象 chat_messages から本文 / session 文脈を解決して runner へ渡す
          // (runner は chat_messages 非依存になったため、 ここで取り出す)。
          let repoPath: string | null = null;
          let sessionActive = false;
          let sessionId: string | null = null;
          if (target.session_id) {
            sessionId = target.session_id;
            const s = deps.sessionsRepo.findSession(target.session_id);
            if (s) {
              repoPath = s.repo_path;
              sessionActive = s.status === "active";
            }
          }
          void reactionWorkflow
            .handle(
              {
                dedupeKey: `chat:${target.id}`,
                emoji: wfEmoji,
                userId: event.user ?? "slack",
                messageText: target.text,
                authorLabel: target.author_label,
                repoPath,
                sessionActive,
                sessionId,
              },
              (action) => {
                void web.chat
                  .postMessage({ channel: channelId, thread_ts: event.thread_ts ?? event.ts, text: getRwf().reactionAckText(action, wfEmoji) })
                  .catch((e) => log.warn(`emoji workflow ack: ${(e as Error).message}`));
              },
              (action, result) => {
                const prefix = result.ok ? "✅" : "⚠️";
                void web.chat
                  .postMessage({
                    channel: channelId,
                    thread_ts: event.thread_ts ?? event.ts,
                    text: `${prefix} ${getRwf().WORKFLOW_ACTION_HELP[action].label}\n\n${result.text}`,
                  })
                  .catch((e) => log.warn(`emoji workflow result: ${(e as Error).message}`));
              },
            )
            .catch((e) => log.warn(`emoji workflow: ${(e as Error).message}`));
          return;
        }
        // 対象が見つからなければ通常経路 (inject / chat) にフォールバック。
      } else if (getRwf().isStandaloneEmoji(wfEmoji) || /^:[a-z0-9_+'-]+:$/i.test(text)) {
        // 単発絵文字 (unicode or :name:) だが該当アクション無し → 却下、 プロンプトも通さない
        // (Discord ingress と同じ挙動)。
        log.info(`reaction-workflow: standalone emoji "${text}" has no workflow action → reject (prompt not forwarded)`);
        return;
      }

      // thread 返信 = その session への inject。
      if (event.thread_ts && event.thread_ts !== event.ts) {
        const row = threads.findByThreadTs(channelId, event.thread_ts);
        if (!row || row.status !== "active") return;
        const authorName = await resolveSlackName(event.user ?? "");
        await injectToSession(deps, row.session_id, text, `slack:${event.user}:${event.ts}`, authorName);
        return;
      }
      // チャンネル直下の発言 = consultation メタチャットへ。
      await postChat(deps, text, event.user ?? "slack-user");
    } catch (e) {
      log.warn(`ingress message handler: ${(e as Error).message}`);
    }
  });

  // ─── interaction: spawn モーダル送信 / 質問ボタン → answer-question ─────────
  socket.on("interactive", async ({ body, ack }: { body: SlackInteractionBody; ack: (res?: unknown) => Promise<void> }) => {
    // `/co-spawn` モーダル: テンプレ選択 (block_actions) → その input_schema を入力欄に
    // 展開するため views.update で②に差し替える。
    if (body?.type === "block_actions") {
      const selectedCall = parseDelegationSelectAction(body);
      if (selectedCall && body.view?.id) {
        try { await ack(); } catch {}
        try {
          const templates = await listDelegationTemplates({ concordiaUrl: deps.concordiaUrl });
          const selected = templates.find((t) => t.call_name === selectedCall) ?? null;
          const workdirs = listWorkdirOptions(resolveWorkspaceRoots());
          await web.views.update({ view_id: body.view.id, view: buildDelegationModalView(templates, workdirs, selected) as never });
        } catch (e) {
          log.warn(`delegation modal update: ${(e as Error).message}`);
        }
        return;
      }
    }
    // `/co-spawn` モーダル送信 → 選んだテンプレを /v1/delegation/invoke {spawn:true} で起動。
    // ack() でモーダルを閉じ、 結果はチャンネルに通知 (view_submission は response_url を持たない)。
    if (body?.type === "view_submission" && body.view?.callback_id === DELEGATION_MODAL_CALLBACK_ID) {
      const parsed = parseDelegationModalSubmit(body.view);
      if (!parsed) { try { await ack(); } catch {} log.warn("delegation modal submit: missing call_name"); return; }
      // テンプレ select の再描画 (views.update) が競合/失敗すると引数入力欄が未描画のまま
      // submit でき、 private_metadata 由来の args が欠落する。権威 schema を再取得して
      // 突き合わせ、 未入力の必須 string arg (典型は task) は「初回指示」で補い、
      // それでも欠ける場合はモーダルを閉じずインラインエラーで知らせる。
      let schema: { name: string; type: "string" | "number" | "boolean"; required: boolean }[] = [];
      // task 未入力時のフォールバック: テンプレの description → title（spawn 時はテンプレから取れる）。
      let fallbackTask = "";
      try {
        const tpls = await listDelegationTemplates({ concordiaUrl: deps.concordiaUrl });
        const tpl = tpls.find((t) => t.call_name === parsed.call_name);
        schema = (tpl?.input_schema ?? []).map((s) => ({ name: s.name, type: s.type, required: s.required }));
        fallbackTask = (tpl?.description ?? "").trim() || (tpl?.title ?? "").trim();
      } catch (e) {
        log.warn(`delegation modal submit: schema fetch failed: ${(e as Error).message}`);
      }
      const { args, extra_prompt, missingRequired } = reconcileDelegationArgs(parsed, schema, fallbackTask);
      if (missingRequired.length) {
        try {
          await ack({ response_action: "errors", errors: { [PROMPT_BLOCK]: `必須項目「${missingRequired.join("・")}」が未入力です。タスク内容を入力してください。` } });
        } catch (e) { log.warn(`delegation modal submit: ack(errors) failed: ${(e as Error).message}`); }
        return;
      }
      try { await ack(); } catch {}
      try {
        const resultText = await invokeDelegation(
          { concordiaUrl: deps.concordiaUrl },
          { call_name: parsed.call_name, args, cwd: parsed.cwd, extra_prompt, triggered_by: `slack:${body.user?.id ?? ""}` },
        );
        // 起動完了メッセージは発火者のみ見える ephemeral にする（チャンネルに残さない）。
        const spawnUserId = body.user?.id ?? "";
        if (spawnUserId) {
          await web.chat.postEphemeral({ channel: channelId, user: spawnUserId, text: resultText });
        } else {
          await web.chat.postMessage({ channel: channelId, text: resultText });
        }
      } catch (e) {
        log.warn(`delegation modal submit: ${(e as Error).message}`);
      }
      return;
    }
    if (body?.type === "view_submission" && body.view?.callback_id === QUESTION_OTHER_MODAL_CALLBACK_ID) {
      let meta: { session_id?: string; question_id?: number } = {};
      try { meta = JSON.parse(body.view.private_metadata ?? "{}"); } catch {}
      const text = readSlackInputValue(body.view.state?.values, QUESTION_OTHER_BLOCK, QUESTION_OTHER_ACTION);
      const questionId = Number(meta.question_id);
      if (!meta.session_id || !Number.isInteger(questionId)) {
        try { await ack({ response_action: "errors", errors: { [QUESTION_OTHER_BLOCK]: "質問情報が見つかりません。" } }); } catch {}
        return;
      }
      if (!text) {
        try { await ack({ response_action: "errors", errors: { [QUESTION_OTHER_BLOCK]: "回答を入力してください。" } }); } catch {}
        return;
      }
      try { await ack(); } catch {}
      try {
        const res = await fetch(
          `${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(meta.session_id)}/answer-question`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ question_id: questionId, other_text: text }),
          },
        );
        if (!res.ok) {
          log.warn(`answer-question(other) failed status=${res.status} qid=${questionId}`);
          return;
        }
        await clearQuestionButtons(questionId, "自由入力");
      } catch (e) {
        log.warn(`question other submit: ${(e as Error).message}`);
      }
      return;
    }
    try { await ack(); } catch {}
    try {
      const action = body?.actions?.[0];
      if (!action?.action_id) return;
      const other = parseOtherAnswerActionId(action.action_id);
      if (other) {
        const sessionRow = threads.findByThreadTs(channelId, body.message?.thread_ts ?? body.message?.ts ?? "");
        if (!sessionRow?.session_id || !body.trigger_id) return;
        await web.views.open({
          trigger_id: body.trigger_id,
          view: buildQuestionOtherModal(sessionRow.session_id, other.questionId) as never,
        });
        return;
      }
      const parsed = parseAnswerActionId(action.action_id);
      if (!parsed) return;
      const sessionRow = threads.findByThreadTs(channelId, body.message?.thread_ts ?? body.message?.ts ?? "");
      const res = await fetch(
        `${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(sessionRow?.session_id ?? "")}/answer-question`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question_id: parsed.questionId, answer_index: parsed.answerIndex }),
        },
      );
      if (!res.ok) {
        log.warn(`answer-question failed status=${res.status} qid=${parsed.questionId}`);
        return;
      }
      // 回答済みを反映してボタンを除去（古いボタンの再クリックを防ぐ）。
      if (body.channel?.id && body.message?.ts) {
        try {
          await web.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `✅ 回答済み (選択肢 ${parsed.answerIndex + 1})`,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: `✅ *回答済み* — 選択肢 ${parsed.answerIndex + 1}` } }] as never,
          });
        } catch (e) {
          log.warn(`chat.update after answer failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      log.warn(`interaction handler: ${(e as Error).message}`);
    }
  });

  // ─── slash commands: /concordia <sub> （読み取り系 stat/prs/help、v0.2）──────
  // Slack app の Slash Commands に `/concordia` を 1 個登録しておく（Socket Mode
  // 経由なので request URL は不要）。spec/feature/slack-platform.md 参照。
  socket.on(
    "slash_commands",
    async ({ body, ack }: { body: { command?: string; text?: string; trigger_id?: string; user_id?: string }; ack: (res?: unknown) => Promise<void> }) => {
      try {
        // `/co-spawn`: 引数なし → delegation テンプレ選択モーダル、 引数あり → 即 raw spawn。
        if ((body?.command ?? "").trim() === "/co-spawn") {
          const args = (body?.text ?? "").trim();
          if (!args && body.trigger_id) {
            await ack();
            try {
              const templates = await listDelegationTemplates({ concordiaUrl: deps.concordiaUrl });
              if (templates.length === 0) {
                await web.chat.postEphemeral({
                  channel: channelId,
                  user: body.user_id ?? "",
                  text: "アクティブな委託テンプレートがありません。`/co-spawn claude` で素のセッションを起動できます。",
                });
                return;
              }
              const workdirs = listWorkdirOptions(resolveWorkspaceRoots());
              await web.views.open({ trigger_id: body.trigger_id, view: buildDelegationModalView(templates, workdirs) as never });
            } catch (e) {
              log.warn(`views.open(delegation) failed: ${(e as Error).message}`);
            }
            return;
          }
          const parts = args.split(/\s+/).filter(Boolean);
          const resultText = await spawnSession({ concordiaUrl: deps.concordiaUrl }, parts[0], parts.slice(1).join(" "));
          await ack({ response_type: "ephemeral", text: resultText });
          return;
        }
        // `/co-<sub>`（spawn 以外）→ 対応サブコマンドへ dispatch。
        // 例: `/co-stat` → `stat`、 `/co-end ab12` → `end ab12`。
        const coSub = subFromCoCommand(body?.command);
        if (coSub) {
          const out = await runSlackSlash({ concordiaUrl: deps.concordiaUrl }, `${coSub} ${body?.text ?? ""}`.trim());
          await ack({ response_type: "ephemeral", text: out });
          return;
        }
        const text = await runSlackSlash({ concordiaUrl: deps.concordiaUrl }, body?.text ?? "");
        await ack({ response_type: "ephemeral", text });
      } catch (e) {
        try { await ack({ response_type: "ephemeral", text: `エラー: ${(e as Error).message}` }); } catch {}
      }
    },
  );

  // ─── custom function: spawn_session（Workflow Builder のカスタムステップ）──────
  // Slack App manifest に function `spawn_session`（inputs: provider, cwd）を定義し、
  // Workflow Builder からステップとして呼ぶ。実行時に function_executed が Socket Mode
  // で届くので、 slash と同じ spawnSession() に流して結果を completeSuccess で返す。
  // slash のように毎回 provider/cwd を打たず、 フォームのドロップダウンで起動できる。
  // 設定手順は spec/setup/slack.md「Slack カスタムワークフロー」節。
  socket.on(
    "function_executed",
    async ({ event, ack }: { event: SlackFunctionExecutedEvent; ack: () => Promise<void> }) => {
      try { await ack(); } catch {}
      const execId = event?.function_execution_id;
      if (!execId) return;
      try {
        if (event.function?.callback_id !== "spawn_session") return; // 想定外の function は無視
        const inputs = event.inputs ?? {};
        const result = await spawnSession({ concordiaUrl: deps.concordiaUrl }, inputs.provider, inputs.cwd);
        await web.functions.completeSuccess({ function_execution_id: execId, outputs: { result } });
      } catch (e) {
        const msg = (e as Error).message;
        log.warn(`function_executed(spawn_session) handler: ${msg}`);
        try { await web.functions.completeError({ function_execution_id: execId, error: msg }); } catch {}
      }
    },
  );

  // ─── reaction_added: リアクションを「指示」として処理に流す（👍=実装着手 等）──
  // 2026-06-10 改訂: chat_messages / message-map には依存せず、 リアクション対象
  // メッセージ本文を Slack API (conversations.history) から直接取得して解釈する。
  // → どのメッセージに付いても発火する。 安全弁 OFF なら無処理。
  socket.on("reaction_added", async ({ event, ack }: { event: SlackReactionEvent; ack: () => Promise<void> }) => {
    try { await ack(); } catch {}
    try {
      if (!reactionWorkflow) return;
      if (!event || event.item?.type !== "message") return;
      if (botUserId && event.user === botUserId) return; // bot 自身のリアクションは無視
      const ch = event.item.channel;
      const ts = event.item.ts;
      if (ch !== channelId || !ts) return;
      const emoji = slackReactionToUnicode(event.reaction ?? "");
      if (!emoji) return; // ワークフロー対象外の絵文字

      // メッセージ本文を Slack API から直接取得 (取れなくても残作業系は本文不要で続行)。
      let messageText = "";
      let authorLabel = event.user ?? "unknown";
      try {
        const hist = await web.conversations.history({ channel: ch, latest: ts, oldest: ts, inclusive: true, limit: 1 });
        const m = hist.messages?.[0] as { text?: string; user?: string } | undefined;
        if (m) {
          messageText = m.text ?? "";
          if (m.user) authorLabel = m.user;
        }
      } catch { /* 本文無しで続行 */ }

      await reactionWorkflow.handle(
        {
          dedupeKey: `${ch}:${ts}`,
          emoji,
          userId: event.user ?? "",
          messageText,
          authorLabel,
          repoPath: null,
          sessionActive: false,
          sessionId: null,
        },
        (action) => {
          void web.chat
            .postMessage({ channel: ch, thread_ts: ts, text: getRwf().reactionAckText(action, emoji) })
            .catch((e) => log.warn(`reaction ack: ${(e as Error).message}`));
        },
        (action, result) => {
          const prefix = result.ok ? "✅" : "⚠️";
          void web.chat
            .postMessage({
              channel: ch,
              thread_ts: ts,
              text: `${prefix} ${getRwf().WORKFLOW_ACTION_HELP[action].label}\n\n${result.text}`,
            })
            .catch((e) => log.warn(`reaction result: ${(e as Error).message}`));
        },
      );
    } catch (e) {
      log.warn(`reaction_added handler: ${(e as Error).message}`);
    }
  });

  socket.on("error", (e: Error) => log.warn(`socket error: ${e?.message ?? String(e)}`));

  await socket.start();
  log.info(`Slack platform connected (channel=${channelId}, bot=${botUserId ?? "?"})`);

  // ─── cost Canvas: Discord の cost チャンネルと同じ集計を「コスト」Canvas に毎回反映 ──
  // canvas_id は slack_config に保存し (= 親 (= Canvas) の id を持っておく)、 以後は edit で
  // 同じ Canvas を上書きする。Discord の cost-channel と同じ refresh 間隔 (既定 10 分)。
  const costCanvasClient: CostCanvasClient = {
    canvases: { edit: (args) => web.canvases.edit(args as never) },
    conversations: { canvases: { create: (args) => web.conversations.canvases.create(args as never) } },
  };
  const refreshCostCanvas = () =>
    upsertCostCanvas({
      client: costCanvasClient,
      channelId,
      sessionsRepo: deps.sessionsRepo,
      configGet: (k) => deps.slackConfigRepo.get(k),
      configSet: (k, v) => deps.slackConfigRepo.set(k, v),
      configDelete: (k) => deps.slackConfigRepo.delete(k),
      log: { info: (m) => log.info(`cost-canvas: ${m}`), warn: (m) => log.warn(`cost-canvas: ${m}`) },
    }).catch((e) => log.warn(`cost canvas refresh failed: ${(e as Error).message}`));
  void refreshCostCanvas();
  const costMins = Math.max(10, Number(process.env.CONCORDIA_SLACK_COST_REFRESH_MIN ?? "10") || 10);
  const costCanvasTimer: ReturnType<typeof setInterval> = setInterval(() => { void refreshCostCanvas(); }, costMins * 60 * 1000);
  costCanvasTimer.unref?.();

  let stopped = false;
  return {
    name: "slack",
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(costCanvasTimer);
      unsubscribe();
      try { await socket.disconnect(); } catch {}
    },
  };
}

// ─── ingress helpers（Concordia HTTP — Discord ingress と同じ宛先）────────────

async function injectToSession(deps: SlackBotDeps, sessionId: string, text: string, source: string, authorLabel?: string): Promise<void> {
  try {
    const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 4000), source, ...(authorLabel ? { author_label: authorLabel } : {}) }),
    });
    if (!res.ok) {
      log.warn(`ingress inject failed status=${res.status} session=${sessionId}`);
      return;
    }
    // Codex は文字列 inject 後に Enter 追送が要る場合がある（Discord ingress と同様）。
    const session = deps.sessionsRepo.findSession(sessionId);
    if (session?.provider === "codex-cli") {
      try {
        await fetch(`${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(sessionId)}/inject`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: ENTER_KEY_TEXT, source: "slack-enter-fallback" }),
        });
      } catch { /* non-fatal */ }
    }
    log.info(`ingress inject ok session=${sessionId}`);
  } catch (e) {
    log.warn(`ingress inject network error session=${sessionId}: ${(e as Error).message}`);
  }
}

async function postChat(deps: SlackBotDeps, text: string, userId: string): Promise<void> {
  try {
    const res = await fetch(`${deps.concordiaUrl}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "consultation",
        text: text.slice(0, 2000),
        author_label: userId,
        metadata: { source: "slack", slack_user_id: userId },
      }),
    });
    if (!res.ok) log.warn(`ingress /v1/chat returned ${res.status}`);
  } catch (e) {
    log.warn(`ingress /v1/chat failed: ${(e as Error).message}`);
  }
}

// 作業ディレクトリ候補 = ワークスペースルートそのもの（リポ単位ではなく `E:/Document/Ars`
// のような束ね単位を選ばせる）。複数ルートが設定されていれば各ルートを 1 候補にする。
// 末尾スラッシュを正規化し、 重複は畳む。候補が 1 つでもそのまま出す（選択の明示になる）。
function listWorkdirOptions(roots: string[]): WorkdirOption[] {
  const out: WorkdirOption[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const value = (root ?? "").replace(/[\\/]+$/, "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ label: value, value });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string; model?: string; delegation_emoji?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string; model?: string; delegation_emoji?: string }; } catch { return {}; }
}

// ─── Slack イベントの最小型（@slack/* の型に依存しすぎないための薄い shape）──
function readSlackInputValue(values: unknown, blockId: string, actionId: string): string {
  const block = values && typeof values === "object" ? (values as Record<string, unknown>)[blockId] : null;
  const action = block && typeof block === "object" ? (block as Record<string, unknown>)[actionId] : null;
  const value = action && typeof action === "object" ? (action as { value?: unknown }).value : null;
  return typeof value === "string" ? value.trim() : "";
}

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}
interface SlackInteractionBody {
  type?: string;
  actions?: Array<{ action_id?: string; value?: string; selected_option?: { value?: string } }>;
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  user?: { id?: string };
  trigger_id?: string;
  view?: { id?: string; callback_id?: string; private_metadata?: string; state?: { values?: Record<string, unknown> } };
}
interface SlackReactionEvent {
  type?: string;
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  item_user?: string;
}
interface SlackFunctionExecutedEvent {
  type?: string;
  function?: { callback_id?: string };
  inputs?: { provider?: string; cwd?: string };
  function_execution_id?: string;
}
