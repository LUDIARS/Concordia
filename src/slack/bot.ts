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
import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { formatAuthorName } from "../discord/formatter.js";
import { reportError, looksLikeFailure } from "../errors.js";
import type { ChatPlatform } from "../platform/chat-platform.js";
import { WorkingIndicator } from "../platform/working-indicator.js";
import { makeSlackSessionThreadsRepo } from "./session-threads-repo.js";
import { makeSlackMessageMapRepo } from "./message-map-repo.js";
import { readSlackEnv, slackEnvReady, readSlackChatMeta, type SlackEnv } from "./types.js";
import {
  buildQuestionBlocks,
  extractRelayableFrame,
  parseAnswerActionId,
  truncateForSlack,
  renderSessionCard,
  extractMonologue,
  slackReactionToUnicode,
  type SessionCardState,
} from "./render.js";
import { runSlackSlash, spawnSession } from "./slash.js";
import { ReactionWorkflowRunner } from "../platform/reaction-workflow.js";
import { runClaude } from "../rules/claude-runner.js";

const slackLog = createChildLogger("slack");
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
  /** リアクションワークフローの安全弁。true の時だけ reaction_added を処理に流す。 */
  reactionWorkflowEnabled?: boolean;
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

  // リアクションワークフロー (👍=実装着手 / 📝=タスク登録 等)。Discord と同じ
  // platform 非依存ランナーを流用。安全弁 OFF の間は構築しない (= reaction 無処理)。
  const reactionWorkflow = deps.reactionWorkflowEnabled
    ? new ReactionWorkflowRunner({
        chatRepo: deps.chatRepo,
        sessionsRepo: deps.sessionsRepo,
        runHeadless: runClaude,
        workspaceRoot: deps.workspaceRoot ?? process.cwd(),
        enabled: true,
        log: { info: (m) => log.info(`reaction-workflow: ${m}`), warn: (m) => log.warn(`reaction-workflow: ${m}`) },
      })
    : null;

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
        const res = await web.chat.postMessage({
          channel: channelId,
          text: renderSessionCard(buildCardState(sessionId, "active")),
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
      await web.chat.update({
        channel: channelId,
        ts: row.thread_ts,
        text: renderSessionCard(buildCardState(sessionId, status, poem)),
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
  async function postToSessionThread(sessionId: string, text: string, author: string): Promise<string | null> {
    const threadTs = await ensureSessionThread(sessionId);
    if (!threadTs) return null;
    try {
      const r = await web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `*${author}*\n${truncateForSlack(text, 12000)}`,
      });
      return (r.ts as string) ?? null;
    } catch (e) {
      log.warn(`postMessage(thread) failed session=${sessionId}: ${(e as Error).message}`);
      return null;
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
      const ts = await postToSessionThread(row.session_id, row.text, author);
      // リアクション逆引き用に ts → chat_messages.id を登録（👍 ワークフローの入口）。
      if (ts) messageMap.put(channelId, ts, row.id);
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
    if (!frame) return;
    const session = deps.sessionsRepo.findSession(ev.target_session_id);
    const meta = readMeta(session?.metadata);
    const persona = frame.role === "assistant" && meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
    const author = frame.role === "summary"
      ? "Conversation summary"
      : formatAuthorName(persona?.display_name ?? null, meta.role_label ?? null);
    await postToSessionThread(ev.target_session_id, frame.text, author);
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
    if (ev.type === "chat.posted") {
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

  // ─── interaction: 質問ボタン → answer-question ─────────────────────────────
  socket.on("interactive", async ({ body, ack }: { body: SlackInteractionBody; ack: () => Promise<void> }) => {
    try { await ack(); } catch {}
    try {
      const action = body?.actions?.[0];
      if (!action?.action_id) return;
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
    async ({ body, ack }: { body: { command?: string; text?: string }; ack: (res?: unknown) => Promise<void> }) => {
      try {
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
  // discord/reactions.ts と同じ意味論を Slack に移植。Slack は ts → chat の逆引きが
  // 無いので slack_message_map で解決し、絵文字名を unicode に正規化してから
  // platform/reaction-workflow.ts の共通ランナーへ渡す。安全弁 OFF なら無処理。
  socket.on("reaction_added", async ({ event, ack }: { event: SlackReactionEvent; ack: () => Promise<void> }) => {
    try { await ack(); } catch {}
    try {
      if (!reactionWorkflow) return;
      if (!event || event.item?.type !== "message") return;
      if (botUserId && event.user === botUserId) return; // bot 自身のリアクションは無視
      const ch = event.item.channel;
      const ts = event.item.ts;
      if (ch !== channelId || !ts) return;
      const chatId = messageMap.findChatId(channelId, ts);
      if (chatId == null) return; // Concordia 投稿でない（= 内部 chat に無い）
      const emoji = slackReactionToUnicode(event.reaction ?? "");
      if (!emoji) return; // ワークフロー対象外の絵文字
      await reactionWorkflow.handle({ chatId, emoji, userId: event.user ?? "" });
    } catch (e) {
      log.warn(`reaction_added handler: ${(e as Error).message}`);
    }
  });

  socket.on("error", (e: Error) => log.warn(`socket error: ${e?.message ?? String(e)}`));

  await socket.start();
  log.info(`Slack platform connected (channel=${channelId}, bot=${botUserId ?? "?"})`);

  let stopped = false;
  return {
    name: "slack",
    async stop() {
      if (stopped) return;
      stopped = true;
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
          body: JSON.stringify({ text: "\n", source: "slack-enter-fallback" }),
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

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string; model?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string; model?: string }; } catch { return {}; }
}

// ─── Slack イベントの最小型（@slack/* の型に依存しすぎないための薄い shape）──
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
  actions?: Array<{ action_id?: string; value?: string }>;
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  user?: { id?: string };
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
