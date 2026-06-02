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
import { makeSlackSessionThreadsRepo, type SlackSessionThreadsRepo } from "./session-threads-repo.js";
import { readSlackEnv, slackEnvReady, readSlackChatMeta, type SlackEnv } from "./types.js";
import {
  buildQuestionBlocks,
  extractRelayableFrame,
  parseAnswerActionId,
  truncateForSlack,
} from "./render.js";
import { runSlackSlash } from "./slash.js";

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
  /** test 用に env を差し替えるための injection（既定は process.env）。 */
  env?: SlackEnv;
}

export async function startSlackBot(deps: SlackBotDeps): Promise<ChatPlatform | null> {
  const env = deps.env ?? readSlackEnv();
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
      const session = deps.sessionsRepo.findSession(sessionId);
      const meta = readMeta(session?.metadata);
      const persona = meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
      const who = formatAuthorName(persona?.display_name ?? null, meta.role_label ?? null);
      const title = session?.current_task?.trim() || sessionId.slice(0, 8);
      try {
        const res = await web.chat.postMessage({
          channel: channelId,
          text: `▶ *${who}* セッション開始 — ${truncateForSlack(title, 120)}\n_(このスレッドに返信すると ${who} に inject されます)_`,
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

  async function postToSessionThread(sessionId: string, text: string, author: string): Promise<void> {
    const threadTs = await ensureSessionThread(sessionId);
    if (!threadTs) return;
    try {
      await web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `*${author}*\n${truncateForSlack(text, 12000)}`,
      });
    } catch (e) {
      log.warn(`postMessage(thread) failed session=${sessionId}: ${(e as Error).message}`);
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
      await postToSessionThread(row.session_id, row.text, author);
      return;
    }
    // セッション非紐付け（chitchat / consultation / 報告 等）はチャンネル直下へ。
    try {
      await web.chat.postMessage({ channel: channelId, text: `*${author}* [${row.channel}]\n${truncateForSlack(row.text, 12000)}` });
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
    } else if (ev.type === "session.ended") {
      working.clear(ev.session_id);
      threads.setStatus(ev.session_id, "ended");
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

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string }; } catch { return {}; }
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
