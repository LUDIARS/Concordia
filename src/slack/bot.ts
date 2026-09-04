// Slack platform 実装（ChatPlatform）。Socket Mode で接続し（Concordia は
// loopback-only で inbound URL を持てないため Events API ではなく Socket Mode）、
// eventBus を購読してセッション出力を Slack に中継、Slack 側の入力を Concordia
// HTTP API に戻す。Hub + public Bot-only session-per-channel 方式。
// spec/feature/slack-platform.md が正本。

import type { Database } from "better-sqlite3";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import type { SlackConfigRepo } from "../db/slack-config-repo.js";
import { upsertCostCanvas, type CostCanvasClient } from "./cost-canvas.js";
import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { formatAuthorName } from "../platform/formatter.js";
import { reportError, looksLikeFailure } from "../errors.js";
import type { ChatPlatform } from "../platform/chat-platform.js";
import { stopLifecycle } from "../platform/lifecycle.js";
import type { ChatReadModel, WorkflowTargetSnapshot } from "../platform/chat-read-model.js";
import { WorkingIndicator } from "../platform/working-indicator.js";
import { classifyReactionIngress } from "../platform/reaction-ingress.js";
import { makeSlackSessionChannelsRepo } from "./session-channels-repo.js";
import {
  SlackSessionChannelProvisioner,
  type SlackSessionChannelDescription,
  type SlackSessionProvisioningClient,
} from "./session-channel-provisioner.js";
import { SlackSessionArchiveLifecycle, type SlackArchiveClient } from "./session-channel-archive.js";
import { SessionsCanvasController, type SessionsCanvasClient } from "./sessions-canvas.js";
import { routeSlackChannelMessage } from "./session-channel-routing.js";
import { makeSlackMessageMapRepo } from "./message-map-repo.js";
import { readSlackEnv, slackEnvReady, type SlackEnv } from "./types.js";
import { wrapTablesInCode } from "../shared/message-blocks.js";
import { parseInjectSource } from "../shared/inject-source.js";
import { renderOperationalClaimMessage } from "../platform/operational-claim.js";
import {
  buildQuestionBlocks,
  buildSessionBotUsername,
  extractRelayableFrame,
  parseAnswerActionId,
  sanitizeSlackMentions,
  truncateForSlack,
  renderSessionCard,
  slackReactionToUnicode,
  deriveTitleFromPost,
  parseOtherAnswerActionId,
  type SessionCardState,
} from "./render.js";
import {
  invokeDelegation,
  isSlackLaunchAuthorized,
  listDelegationTemplates,
  runSlackSlash,
  spawnSession,
  subFromCoCommand,
  type SlashDeps,
} from "./slash.js";
import {
  buildDelegationModalView,
  parseDelegationModalSubmit,
  parseDelegationSelectAction,
  reconcileDelegationArgs,
  DELEGATION_MODAL_CALLBACK_ID,
  PROMPT_BLOCK,
} from "./delegation-modal.js";
import { type RwfRunOptions, type RwfRunResult, type WorkflowAction } from "../platform/reaction-workflow.js";
import type { RwfPrOperations } from "../platform/reaction-workflow-pr.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import { buildSlackSessionTopic } from "./projection.js";
import { listWorkdirOptions, readSlackInputValue } from "./modal.js";
import { injectToSession, postChat } from "./router.js";

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
  readModel: ChatReadModel;
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
  /** アクション別ポリシー (子会社可否/要求権限) の live 解決。 Slack は常に本社扱い。 */
  resolveReactionActionPolicies?: () => import("../platform/reaction-workflow-capability.js").WorkflowActionPolicies;
  /**
   * リアクションワークフローの発火可否。 発火自体は誰でも可 (`reaction_workflow` =
   * ヒラ社員) なので実質は素通しゲート。 実行可否は下の `hasStaffCapability` が決める。
   */
  isReactionWorkflowUserAllowed?: (userId: string) => boolean;
  /**
   * リアクションワークフローの各アクションが要求する権限の判定。 リアクション自体は
   * 誰でも押せるので、 発火可否ではなく「指示の内容が実行できるか」を見る。
   */
  hasStaffCapability?: (userId: string, capability: import("../staff/roles.js").StaffCapability) => boolean;
  /** 社員名簿 (staff_members) の役職に基づく spawn 権限判定 (管理職以上)。 */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /** 同じく end-session 権限判定 (管理職以上)。 Discord `/end-session` と同じ capability。 */
  isSessionEndUserAllowed?: (userId: string) => boolean;
  /** LLM に届く発言をした Slack ユーザを社員名簿へ記録する。 */
  recordStaffAccess?: (input: { userId: string; displayName?: string; profileName?: string }) => void;
  /**
   * 📋 list-local-prs / 📮 submit-pr / 🔀 merge-pr の実体 (Revisor local PR)。 Slack の名簿で役職を引く
   * インスタンスを渡す。 未注入なら PR 操作は実行せず理由を返す。
   */
  prOperations?: RwfPrOperations;
  runHeadless: (prompt: string, opts?: RwfRunOptions) => Promise<RwfRunResult>;
  /** Unit/integration test boundary. Production constructs official Slack clients. */
  webClient?: WebClient;
  socketClient?: SocketModeClient;
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
  if (env.archiveDelayInvalid) {
    log.warn("CONCORDIA_SLACK_ARCHIVE_DELAY_MIN is invalid; using default 30 minutes");
  }
  const channelId = env.channelId!;
  const web = deps.webClient ?? new WebClient(env.botToken!);
  const socket = deps.socketClient ?? new SocketModeClient({ appToken: env.appToken! });
  const channels = makeSlackSessionChannelsRepo(deps.db);
  const messageMap = makeSlackMessageMapRepo(deps.db);

  // /co-spawn の作業ディレクトリ候補に使うワークスペースルート群を live 解決する。
  const resolveWorkspaceRoots = (): string[] => {
    const multi = deps.resolveWorkspaceRoots?.();
    if (multi && multi.length) return multi;
    const single = deps.resolveWorkspaceRoot?.() || deps.workspaceRoot;
    return single ? [single] : [];
  };
  const slashDepsFor = (actorUserId: string | undefined): SlashDeps => ({
    concordiaUrl: deps.concordiaUrl,
    actorUserId,
    isLaunchUserAllowed: deps.isLaunchUserAllowed,
    isSessionEndUserAllowed: deps.isSessionEndUserAllowed,
  });

  // リアクションワークフロー (👍=実装着手 / 📝=タスク登録 等)。Discord と同じ
  // platform 非依存ランナーを流用。runner は常に構築し、 安全弁は handle() 内で live 評価
  // (設定 GUI トグルを bot 再起動なしで反映)。
  const reactionWorkflow = new (getRwf().ReactionWorkflowRunner)({
    runHeadless: deps.runHeadless,
    emitInject: (sessionId, text, source, provenance) =>
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, ...(provenance ? { provenance } : {}), ts: Math.floor(Date.now() / 1000) }),
    workspaceRoot: deps.resolveWorkspaceRoot?.() || deps.workspaceRoot || process.cwd(),
    workspaceRoots: deps.resolveWorkspaceRoots?.(),
    enabled: deps.resolveReactionWorkflowEnabled ?? (() => deps.reactionWorkflowEnabled ?? false),
    customMappings: deps.resolveReactionMappings,
    // リアクションは誰でも押せるが、 中身が spawn / merge を要求するならここで役職を問う。
    hasCapability: deps.hasStaffCapability,
    // Slack は本社のみ (子会社 Bot は未配線) だが、権限上書きポリシーは共有する。
    resolveActionPolicies: deps.resolveReactionActionPolicies,
    // 📋 list-local-prs / 📮 submit-pr / 🔀 merge-pr の実体 (Revisor local PR)。
    prOperations: deps.prOperations,
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

  // ライブカードの状態を session 行から組む（同期・純粋寄り）。
  // ended の poem は呼び出し側 (renderEndedCard) が埋める。
  function buildSessionCard(sessionId: string, status: "active" | "ended", poem?: string | null): SessionCardState {
    return deps.readModel.getSessionCardState(sessionId, status, poem) ?? {
      who: formatAuthorName(null, null),
      emoji: null,
      provider: null,
      model: null,
      effortLevel: null,
      currentTask: null,
      shortId: sessionId.slice(0, 8),
      status,
      poem: poem ?? null,
    };
  }

  function describeSession(sessionId: string): SlackSessionChannelDescription {
    const state = buildSessionCard(sessionId, "active");
    const card = renderSessionCard(state);
    return {
      title: state.currentTask ?? null,
      topic: buildSlackSessionTopic(state),
      header: { text: card.text, blocks: card.blocks, username: buildSessionBotUsername(state) },
    };
  }

  const provisioner = new SlackSessionChannelProvisioner({
    repo: channels,
    client: web as unknown as SlackSessionProvisioningClient,
    describeSession,
    log,
  });

  // session channel の先頭 header を現在の状態で再描画する。task / title 更新時に呼ぶ。
  async function renderHeaderCard(sessionId: string, status: "active" | "ended" = "active", poem?: string | null): Promise<void> {
    const row = channels.findBySessionId(sessionId);
    if (!row) return;
    if (!row.header_ts) {
      await provisioner.ensure(sessionId);
      return;
    }
    try {
      const state = buildSessionCard(sessionId, status, poem);
      const card = renderSessionCard(state);
      await web.chat.update({
        channel: row.channel_id,
        ts: row.header_ts,
        text: card.text,
        blocks: card.blocks as never,
      });
      await provisioner.refreshMetadata(sessionId, buildSlackSessionTopic(state));
    } catch (e) {
      log.warn(`session header update failed session=${sessionId}: ${(e as Error).message}`);
    }
  }

  // session.ended: report の独白ポエムを抜いて header を「✅ Done + ポエム」に差し替える。
  async function renderEndedCard(sessionId: string): Promise<void> {
    const poem = deps.readModel.getEndedSessionPoem(sessionId);
    await renderHeaderCard(sessionId, "ended", poem);
  }

  // session channel のトップレベルに1件投稿し、posted ts を返す（messageMap 登録用）。
  async function postToSessionChannel(sessionId: string, text: string, author: string): Promise<string | null> {
    const surface = await provisioner.ensure(sessionId);
    try {
      const sanitized = sanitizeSlackMentions(truncateForSlack(wrapTablesInCode(text), 12000));
      const r = await web.chat.postMessage({
        channel: surface.channel_id,
        username: author,
        text: sanitized,
      });
      const ts = (r.ts as string) ?? null;
      log.info(`[verbose-slack-egress] channel relay ok session=${sessionId} channel=${surface.channel_id} ts=${ts ?? "?"} len=${text.length}`);
      return ts;
    } catch (e) {
      log.warn(`postMessage(session channel) failed session=${sessionId}: ${(e as Error).message}`);
      return null;
    }
  }

  // 最初のスレッド投稿で /rename 相当を発火し、 親カード（📌）を投稿本文から更新する。
  // current_task が空（= カードがセッション id 先頭8桁にフォールバックしている）ときだけ
  // 発火し、 prompt 由来の実 current_task は上書きしない。 1 セッション 1 回（in-memory）。
  const autoTitledSessions = new Set<string>();
  async function maybeAutoTitleFromFirstPost(sessionId: string, text: string): Promise<void> {
    if (autoTitledSessions.has(sessionId)) return;
    const session = deps.readModel.getSessionRelayState(sessionId);
    if (!session) return;
    if ((session.currentTask ?? "").trim()) { autoTitledSessions.add(sessionId); return; } // 既に題あり
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
    const row = deps.readModel.getChatMessage(ev.message_id);
    if (!row) return;
    // Slack ingress 由来の chat は既に Slack 上に表示済 → 自己ループ防止。
    if (row.metadata.source === "slack") {
      log.info(`chat.posted skipped — source=slack (self-loop) message_id=${row.id}`);
      return;
    }
    const author = row.authorLabel?.trim() || "Concordia";
    if (row.sessionId) {
      log.info(`[verbose-slack-egress] chat.posted → channel session=${row.sessionId} message_id=${row.id} channel=${row.channel}`);
      const ts = await postToSessionChannel(row.sessionId, row.text, author);
      // リアクション逆引き用に ts → chat_messages.id を登録（👍 ワークフローの入口）。
      const surface = channels.findBySessionId(row.sessionId);
      if (ts && surface) messageMap.put(surface.channel_id, ts, row.id);
      // 最初の投稿なら投稿本文からカードのやる事(📌)を起こす（/rename 相当）。
      void maybeAutoTitleFromFirstPost(row.sessionId, row.text).catch((e) =>
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
    const session = deps.readModel.getSessionRelayState(ev.target_session_id);
    const author = frame.role === "summary"
      ? "Conversation summary"
      : formatAuthorName(null, session?.roleLabel ?? null);
    log.info(`[verbose-slack-egress] transcript.frame → channel session=${ev.target_session_id} role=${frame.role}`);
    await postToSessionChannel(ev.target_session_id, frame.text, author);
    // assistant 本文の最初の1件で /rename 相当（summary は題材にしない）。
    if (frame.role === "assistant") {
      void maybeAutoTitleFromFirstPost(ev.target_session_id, frame.text).catch((e) =>
        log.warn(`auto-title (transcript.frame): ${(e as Error).message}`),
      );
    }
  }

  // question_id → 投稿した質問メッセージの channel/ts。回答時に質問自身を更新する。
  // 再起動で消えるが、その場合でも Concordia 側 markAnswered で再クリックは弾かれる。
  const questionMessages = new Map<number, { channelId: string; ts: string }>();

  async function handleQuestionPosted(ev: Extract<ConcordiaEvent, { type: "question.posted" }>): Promise<void> {
    const surface = await provisioner.ensure(ev.target_session_id);
    const { text, blocks } = buildQuestionBlocks(ev.question_id, ev.question, ev.options);
    try {
      const r = await web.chat.postMessage({ channel: surface.channel_id, text, blocks: blocks as never });
      if (typeof r.ts === "string") questionMessages.set(ev.question_id, { channelId: surface.channel_id, ts: r.ts });
    } catch (e) {
      log.warn(`question post failed session=${ev.target_session_id} qid=${ev.question_id}: ${(e as Error).message}`);
    }
  }

  async function handleOperationalClaim(
    ev: Extract<ConcordiaEvent, { type: "operational.claim.opened" | "operational.claim.released" }>,
  ): Promise<void> {
    if (ev.type === "operational.claim.opened" && !deps.readModel.isSessionActive(ev.target_session_id)) return;
    const surface = channels.findBySessionId(ev.target_session_id);
    if (!surface) return;
    await web.chat.postMessage({
      channel: surface.channel_id,
      text: sanitizeSlackMentions(renderOperationalClaimMessage(ev)),
      username: "Cc claims",
    });
  }

  // 回答済み / ローカル解決時に質問メッセージのボタンを外す（再クリック防止）。
  async function clearQuestionButtons(questionId: number, label: string): Promise<void> {
    const message = questionMessages.get(questionId);
    if (!message) return;
    questionMessages.delete(questionId);
    try {
      await web.chat.update({
        channel: message.channelId,
        ts: message.ts,
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

  // 「作業中」インジケータ: session channel のトップレベルに「🔄 作業中…」を出し、進捗で
  // 消して落ち着いたら出し直す。Discord と同じ platform 非依存コントローラを流用し、
  // post/remove だけ Slack channel 用に差す。spec/feature/working-indicator.md
  const idleSec = Math.max(15, Number(process.env.CONCORDIA_SLACK_WORKING_IDLE_SEC ?? "60") || 60);
  const working = new WorkingIndicator({
    idleMs: idleSec * 1000,
    log: (m) => log.info(`working-indicator: ${m}`),
    post: async (sessionId) => {
      const surface = await provisioner.ensure(sessionId);
      try {
        const r = await web.chat.postMessage({ channel: surface.channel_id, text: "🔄 *作業中…*" });
        return (r.ts as string) ?? null;
      } catch (e) {
        log.warn(`working post failed session=${sessionId}: ${(e as Error).message}`);
        return null;
      }
    },
    remove: async (sessionId, ts) => {
      const surface = channels.findBySessionId(sessionId);
      if (!surface) return;
      try { await web.chat.delete({ channel: surface.channel_id, ts }); } catch { /* best-effort: indicator may already be gone */ }
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

  // 相手PF(Discord)由来の inject を Slack の該当 session channel に発言者付きで転記。
  // Slack 由来は元発言が channel に既出のため転記しない。制御 inject は ^discord: に
  // 一致せず除外。
  async function mirrorForeignInject(ev: Extract<ConcordiaEvent, { type: "session.inject" }>): Promise<void> {
    const src = ev.source ?? "";
    if (parseInjectSource(src).platform !== "discord") return;
    const surface = await provisioner.ensure(ev.target_session_id);
    const who = ev.author_label?.trim() || "Discord user";
    await web.chat.postMessage({
      channel: surface.channel_id,
      text: `🔁 *Discord / ${who}*\n${truncateForSlack(ev.text, 12000)}`,
    });
  }

  const sessionsCanvas = new SessionsCanvasController({
    client: web as unknown as SessionsCanvasClient,
    hubChannelId: channelId,
    getSessions: () => deps.readModel.listSlackSessionIndex?.() ?? [],
    channelForSession: (sessionId) => channels.findBySessionId(sessionId)?.channel_id ?? null,
    configGet: (key) => deps.slackConfigRepo.get(key),
    configSet: (key, value) => deps.slackConfigRepo.set(key, value),
    configDelete: (key) => deps.slackConfigRepo.delete(key),
    log: { info: (message) => log.info(`sessions-canvas: ${message}`), warn: (message) => log.warn(`sessions-canvas: ${message}`) },
  });

  const archiveLifecycle = new SlackSessionArchiveLifecycle({
    repo: channels,
    client: web as unknown as SlackArchiveClient,
    delaySeconds: env.archiveDelayMin * 60,
    onArchived: () => sessionsCanvas.schedule(),
    log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
  });

  async function handleSessionStarted(sessionId: string): Promise<void> {
    // 同じ session_id の再開 (再接続/resume) であれば、 session.ended で立った
    // archive 予約をここで取り消す。 取り消さないと、 再開後もアクティブな
    // チャンネルが次の sweep で誤って archive されてしまう (継続レビュー指摘)。
    archiveLifecycle.cancel(sessionId);
    await provisioner.ensure(sessionId);
    sessionsCanvas.schedule();
  }

  async function handleSessionEnded(sessionId: string): Promise<void> {
    working.clear(sessionId);
    await provisioner.ensure(sessionId);
    await renderEndedCard(sessionId);
    await archiveLifecycle.schedule(sessionId);
    sessionsCanvas.schedule();
  }

  const unsubscribe = eventBus.subscribe((ev) => {
    if (ev.type === "session.started") {
      void handleSessionStarted(ev.session_id).catch((e) =>
        log.warn(`session.started channel provisioning: ${(e as Error).message}`));
    } else if (ev.type === "chat.posted") {
      void handleChatPosted(ev).catch((e) => log.warn(`chat.posted dispatch: ${(e as Error).message}`));
      if (ev.session_id) working.noteProgress(ev.session_id);
    } else if (ev.type === "transcript.frame") {
      void handleTranscriptFrame(ev).catch((e) => log.warn(`transcript.frame dispatch: ${(e as Error).message}`));
      working.noteProgress(ev.target_session_id);
    } else if (ev.type === "question.posted") {
      void handleQuestionPosted(ev).catch((e) => log.warn(`question.posted dispatch: ${(e as Error).message}`));
      sessionsCanvas.schedule();
    } else if (ev.type === "question.answered") {
      void clearQuestionButtons(ev.question_id, `✅ *回答済み* — 選択肢 ${ev.answer_index + 1}`);
      sessionsCanvas.schedule();
    } else if (ev.type === "question.resolved") {
      void clearQuestionButtons(ev.question_id, "✅ *回答済み（ローカル）*");
      sessionsCanvas.schedule();
    } else if (ev.type === "operational.claim.opened" || ev.type === "operational.claim.released") {
      void handleOperationalClaim(ev).catch((e) =>
        log.warn(`claim lifecycle post failed session=${ev.target_session_id}: ${(e as Error).message}`));
    } else if (ev.type === "session.inject") {
      // 環境同期: 相手PF(Discord)由来の inject を Slack session channel に転記。
      void mirrorForeignInject(ev).catch((e) => log.warn(`session.inject mirror: ${(e as Error).message}`));
    } else if (ev.type === "session.event" && ev.kind === "prompt") {
      working.noteProgress(ev.session_id);
    } else if (ev.type === "session.event" && (ev.kind === "title_renamed" || ev.kind === "task_update")) {
      void renderHeaderCard(ev.session_id).catch((e) => log.warn(`session header reflect: ${(e as Error).message}`));
      sessionsCanvas.schedule();
    } else if (ev.type === "report.generated") {
      void renderEndedCard(ev.session_id).catch((e) => log.warn(`ended header report: ${(e as Error).message}`));
      sessionsCanvas.schedule();
    } else if (ev.type === "session.ended") {
      void handleSessionEnded(ev.session_id).catch((e) => log.warn(`session.ended lifecycle: ${(e as Error).message}`));
    } else if (ev.type === "session.lost") {
      working.clear(ev.session_id);
      sessionsCanvas.schedule();
    }
  });

  // ─── ingress: Slack message → Concordia inject / chat ──────────────────────
  socket.on("message", async ({ event, ack }: { event: SlackMessageEvent; ack: () => Promise<void> }) => {
    try { await ack(); } catch {}
    try {
      if (!event) return;
      const route = routeSlackChannelMessage({
        event,
        hubChannelId: channelId,
        botUserId,
        sessionForChannel: (candidate) => channels.findByChannelId(candidate)?.session_id ?? null,
        // 終了済み session のチャンネル (archive 待ちで残っている間) への投稿を
        // inject 扱いにしない (継続レビュー指摘: session-channel-routing.ts:28)。
        isSessionActive: (sessionId) => deps.readModel.isSessionActive(sessionId),
      });
      if (route.kind === "ignore") {
        if (route.reason === "thread_reply") {
          log.info(`Slack thread reply ignored; session routing requires a top-level channel message channel=${event.channel ?? "?"}`);
        } else if (route.reason === "session_inactive") {
          log.info(`Slack message ignored; mapped session is no longer active channel=${event.channel ?? "?"}`);
        }
        return;
      }
      const text = (event.text ?? "").trim();
      if (!text || text.startsWith("//")) return;

      // ここから先は LLM に届く経路。 発言者を社員名簿へ記録する (Discord ingress と同じ)。
      // Slack は guild nickname に相当する値がイベントに無いので user ID のみ記録し、
      // 表示名は WebUI で補える扱いにする。
      if (event.user) deps.recordStaffAccess?.({ userId: event.user });

      if (route.kind === "session") {
        // 単発絵文字は専用 session channel 内だけで RWF に流す。直近 chat 行が無くても
        // session 文脈で起動し、本文だけを空として扱う (Discord ingress と同じ契約)。
        const reactionRoute = classifyReactionIngress({
          text,
          normalize: slackEmojiTextToUnicode,
          classify: (emoji) => getRwf().classifyReactionWorkflow(emoji, deps.resolveReactionMappings?.()),
          isStandaloneEmoji: getRwf().isStandaloneEmoji,
          isNamedEmoji: (value) => /^:[a-z0-9_+'-]+:$/i.test(value),
        });
        if (
          reactionRoute.kind !== "prompt" &&
          (!event.user || !deps.isReactionWorkflowUserAllowed?.(event.user))
        ) {
          log.info(`emoji workflow ignored unauthorized user=${event.user ?? "-"}`);
          return;
        }
        if (reactionRoute.kind === "workflow") {
          const target: WorkflowTargetSnapshot | null = deps.readModel.getLatestWorkflowTargetForSession(route.sessionId);
          const sessionState = deps.readModel.getSessionRelayState(route.sessionId);
          void reactionWorkflow
            .handle(
              {
                dedupeKey: target ? `chat:${target.id}` : `slack:${event.ts}`,
                platform: "slack",
                sourceMessageId: `${event.channel}:${event.ts}`,
                emoji: reactionRoute.emoji,
                userId: event.user ?? "slack",
                messageText: target?.text ?? "",
                authorLabel: target?.authorLabel ?? "unknown",
                repoPath: target?.repoPath ?? sessionState?.repoPath ?? null,
                sessionActive: target?.sessionActive ?? sessionState?.status === "active",
                sessionId: route.sessionId,
              },
              (action) => {
                void web.chat
                  .postMessage({ channel: route.channelId, text: getRwf().reactionAckText(action, reactionRoute.emoji) })
                  .catch((e) => log.warn(`emoji workflow ack: ${(e as Error).message}`));
              },
              (action, result) => {
                const prefix = result.ok ? "✅" : "⚠️";
                void web.chat
                  .postMessage({
                    channel: route.channelId,
                    text: `${prefix} ${getRwf().WORKFLOW_ACTION_HELP[action].label}\n\n${result.text}`,
                  })
                  .catch((e) => log.warn(`emoji workflow result: ${(e as Error).message}`));
              },
            )
            .catch((e) => log.warn(`emoji workflow: ${(e as Error).message}`));
          return;
        }
        if (reactionRoute.kind === "unsupported-emoji") {
          log.info(`reaction-workflow: standalone emoji "${text}" has no workflow action → reject (prompt not forwarded)`);
          return;
        }
      }

      if (route.kind === "session") {
        const authorName = await resolveSlackName(event.user ?? "");
        await injectToSession(deps, route.sessionId, text, `slack:${event.user}:${event.ts}`, authorName);
        return;
      }
      // Hub のトップレベル発言 = 既存 consultation メタチャットへ。
      const relaySessionId = deps.readModel.getLatestWorkflowTargetForChannel("consultation")?.sessionId ?? null;
      await postChat(deps, text, event.user ?? "slack-user", relaySessionId);
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
          slashDepsFor(body.user?.id),
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
        const sessionRow = body.channel?.id ? channels.findByChannelId(body.channel.id) : null;
        if (!sessionRow?.session_id || !body.trigger_id) return;
        await web.views.open({
          trigger_id: body.trigger_id,
          view: buildQuestionOtherModal(sessionRow.session_id, other.questionId) as never,
        });
        return;
      }
      const parsed = parseAnswerActionId(action.action_id);
      if (!parsed) return;
      const sessionRow = body.channel?.id ? channels.findByChannelId(body.channel.id) : null;
      if (!sessionRow) return;
      const res = await fetch(
        `${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(sessionRow.session_id)}/answer-question`,
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
          const slashDeps = slashDepsFor(body.user_id);
          if (!isSlackLaunchAuthorized(slashDeps)) {
            await ack({ response_type: "ephemeral", text: "このユーザーにはセッション起動権限がありません。" });
            return;
          }
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
          const resultText = await spawnSession(slashDeps, parts[0], parts.slice(1).join(" "));
          await ack({ response_type: "ephemeral", text: resultText });
          return;
        }
        // `/co-<sub>`（spawn 以外）→ 対応サブコマンドへ dispatch。
        // 例: `/co-stat` → `stat`、 `/co-end ab12` → `end ab12`。
        const coSub = subFromCoCommand(body?.command);
        if (coSub) {
          const out = await runSlackSlash(slashDepsFor(body.user_id), `${coSub} ${body?.text ?? ""}`.trim());
          await ack({ response_type: "ephemeral", text: out });
          return;
        }
        const text = await runSlackSlash(slashDepsFor(body.user_id), body?.text ?? "");
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
        const actorUserId = event.user_id ?? inputs.user_id;
        const result = await spawnSession(slashDepsFor(actorUserId), inputs.provider, inputs.cwd);
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
  // → 専用 session channel 内のメッセージだけで発火する。安全弁 OFF なら無処理。
  socket.on("reaction_added", async ({ event, ack }: { event: SlackReactionEvent; ack: () => Promise<void> }) => {
    try { await ack(); } catch {}
    try {
      if (!reactionWorkflow) return;
      if (!event || event.item?.type !== "message") return;
      if (botUserId && event.user === botUserId) return; // bot 自身のリアクションは無視
      if (event.user) deps.recordStaffAccess?.({ userId: event.user });
      if (!event.user || !deps.isReactionWorkflowUserAllowed?.(event.user)) {
        log.info(`reaction_added ignored unauthorized user=${event.user ?? "-"}`);
        return;
      }
      const ch = event.item.channel;
      const ts = event.item.ts;
      if (!ch || !ts) return;
      const sessionSurface = channels.findByChannelId(ch);
      if (!sessionSurface) return;
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

      const sessionState = deps.readModel.getSessionRelayState(sessionSurface.session_id);
      await reactionWorkflow.handle(
        {
          dedupeKey: `${ch}:${ts}`,
          platform: "slack",
          sourceMessageId: `${ch}:${ts}`,
          emoji,
          userId: event.user ?? "",
          messageText,
          authorLabel,
          repoPath: sessionState?.repoPath ?? null,
          sessionActive: sessionState?.status === "active",
          sessionId: sessionSurface.session_id,
        },
        (action) => {
          void web.chat
            .postMessage({ channel: ch, text: getRwf().reactionAckText(action, emoji) })
            .catch((e) => log.warn(`reaction ack: ${(e as Error).message}`));
        },
        (action, result) => {
          const prefix = result.ok ? "✅" : "⚠️";
          void web.chat
            .postMessage({
              channel: ch,
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

  await archiveLifecycle.start();
  const activeSessions = (deps.readModel.listSlackSessionIndex?.() ?? [])
    .filter((session) => session.status === "active");
  const reconciled = await Promise.allSettled(
    activeSessions.map((session) => provisioner.ensure(session.sessionId)),
  );
  reconciled.forEach((result, index) => {
    if (result.status === "rejected") {
      log.warn(`Slack startup session provisioning failed session=${activeSessions[index].sessionId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });
  await sessionsCanvas.refreshNow();

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
      readModel: deps.readModel,
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
    async postToSession(input) {
      await postToSessionChannel(input.sessionId, input.text, input.authorLabel?.trim() || "Concordia");
    },
    async ensureSessionSurface(sessionId) {
      await provisioner.ensure(sessionId);
      await renderHeaderCard(sessionId);
      sessionsCanvas.schedule();
    },
    async postQuestion(input) {
      await handleQuestionPosted({
        type: "question.posted",
        target_session_id: input.target_session_id,
        question_id: input.question_id,
        question: input.question,
        options: input.options,
        ts: Math.floor(Date.now() / 1000),
      });
    },
    async relayFrame(input) {
      await handleTranscriptFrame({
        type: "transcript.frame",
        target_session_id: input.target_session_id,
        kind: input.kind as never,
        payload: input.payload as never,
        seq: input.seq ?? 0,
        ts: Math.floor(Date.now() / 1000),
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopLifecycle([
        { name: "cost canvas timer", stop: () => clearInterval(costCanvasTimer) },
        { name: "event subscription", stop: () => unsubscribe() },
        { name: "working indicators", stop: () => {
          for (const session of deps.readModel.listSlackSessionIndex?.() ?? []) working.clear(session.sessionId);
        } },
        { name: "archive lifecycle", stop: () => archiveLifecycle.stop() },
        { name: "sessions canvas", stop: () => sessionsCanvas.stop() },
        { name: "socket", stop: () => socket.disconnect() },
      ], (message) => log.warn(message));
    },
  };
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
  /** Slack workflow actor. If the event omits it, a workflow input must carry user_id. */
  user_id?: string;
  inputs?: { provider?: string; cwd?: string; user_id?: string };
  function_execution_id?: string;
}
