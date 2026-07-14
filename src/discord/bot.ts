import { ChannelType, Client, Events, GatewayIntentBits, Partials, type Guild } from "discord.js";
import type { Database } from "better-sqlite3";
import type { ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import {
  makeChatMessageReactionsRepo,
  makeDiscordConfigRepo,
  makeDiscordMessageMapRepo,
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import { ensureDeskChannel, ensureDiscordLayout, ensureIntakeChannel, type DiscordConfigSnapshot, type EnsureLayoutOptions } from "./config.js";
import { getEgressDedupStats, handleEvent as handleEgressEvent, isActiveRelayTarget } from "./egress.js";
import { handleMessage as handleIngressMessage } from "./ingress.js";
import { handleReactionAdd, handleReactionRemove } from "./reactions.js";
import { shouldRestartDiscordBot } from "./gateway-policy.js";
import { type RwfRunOptions, type RwfRunResult, type WorkflowAction } from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import {
  onSessionRegistered,
  onSessionStatusChanged,
  onSessionTitleChanged,
  onSessionWorkState,
  updateSessionSurfaceMetadata,
  pruneStatusCategoryChannels,
  reconcileEndedSessionChannels,
  reconcileLostSessionChannels,
  archiveStaleChannels,
} from "./session-channel.js";
import { ChannelWorkState } from "./channel-work-state.js";
import { replayPersistedTranscript, type TranscriptReplaySource } from "./transcript-replay.js";
import { upsertSessionStatusCard, deleteSessionStatusCard, reconcileLostStatusCards, getStatusChannelId } from "./session-status-card.js";
import { takeInjectAck } from "./inject-ack.js";
import { upsertCostChannelMessage } from "./cost-channel.js";
import { upsertMonitorChannelMessage } from "./monitor-channel.js";
import { upsertPrQueueChannelMessage } from "./pr-queue-channel.js";
import { ErrorChannelPoster } from "./error-channel.js";
import { startVestigiumErrorWatch, type ErrorMonitorHandle } from "./error-monitor.js";
import { reportError, looksLikeFailure } from "../errors.js";
import { WebhookPool } from "./webhook-pool.js";
import { readDiscordEnv, type DiscordEnv } from "./types.js";
import { dispatchInteraction, registerGuildCommands } from "./commands.js";
import { describeInteractionForLog, interactionAgeMs } from "./interaction-diagnostics.js";
import {
  delegationTemplateCache,
  invalidateAndRefreshDelegationTemplateCache,
  prewarmDelegationTemplateCache,
} from "./delegation-template-cache.js";
import { postQuestion, resolveQuestionMessage } from "./question.js";
import { postPermissionRequest, type PermissionActionStore } from "./permission.js";
import { createChildLogger } from "../shared/logger.js";
import { parseInjectSource } from "../shared/inject-source.js";
import { WorkingIndicator } from "../platform/working-indicator.js";
import type { ChatPlatform } from "../platform/chat-platform.js";
import type { ChatReadModel } from "../platform/chat-read-model.js";
import { excubitorBaseUrl, excubitorProjectCache } from "./excubitor-project-cache.js";
import { instrumentDiscord, recordDiscordInteractionAck } from "../instrumentation.js";
import { startInteractionAckProbe } from "./interaction-ack.js";
import { createForumProjectResolver } from "./forum-project-code.js";
import {
  handleForumSpawnThread,
  parseForumSpawnTrigger,
  type ForumSpawnThread,
} from "./forum-spawn.js";
import {
  fetchForumSessionThread,
  postForumSessionMetadata,
  resolveForumSessionSurface,
  updateForumSessionState,
} from "./forum-session.js";

// pino 経由で logs/concordia.log にも残る. egress / session-channel に渡す
// deps.log もこの object 経由になるので、 過剰ログを仕込んだ場所の出力が
// 一律にファイルに記録される.
const discordLog = createChildLogger("discord");
// warn/error のうち「失敗」 を表すものは reportError 経由で errors チャンネルへも転記.
// (cost channel unavailable 等の非失敗 warn はノイズになるので looksLikeFailure で除外)
const log = {
  info: (m: string) => discordLog.info(m),
  warn: (m: string) => {
    discordLog.warn(m);
    if (looksLikeFailure(m)) reportError("discord", m);
  },
  error: (m: string) => {
    discordLog.error(m);
    reportError("discord", m);
  },
};

export function shouldRelaySessionPromptToDiscord(provider: string | null | undefined): boolean {
  return provider === "codex-cli";
}

export function shouldPostPermissionRequestToDiscord(env: Pick<DiscordEnv, "permissionRequestsEnabled">): boolean {
  return env.permissionRequestsEnabled;
}

export type DiscordHeadlessRunner = (prompt: string, opts?: RwfRunOptions) => Promise<RwfRunResult>;
export type DiscordRepinSession = (sessionId: string) => Promise<{ ok: boolean; path?: string | null; error?: string }>;

export interface DiscordBotDeps {
  db: Database;
  readModel: ChatReadModel;
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  /**
   * channel 作成前に届いた transcript frame の埋め戻し (transcript-replay) に使う。
   * 省略時は replay をスキップ (standalone worker 等、 repo を持たない構成)。
   */
  transcriptLogs?: TranscriptReplaySource & { maxId(sessionId: string): number };
  /** Concordia の依頼 (chat-reply / title-suggest 等の pending tasks) の集計に使う. */
  /** PR キューの自動更新メッセージ / pr.changed 再描画に使う. */
  /**
   * 子会社一覧を live 解決する (本社モニターの「本社/子会社別コスト」用)。 本社 Bot のみ
   * 渡され、 子会社 Bot には渡さない (subsidiary モードでは無視 = 他子会社の漏洩防止)。
   */
  listSubsidiaries?: () => Array<{ id: string; name: string; daily_token_budget: number }>;
  concordiaUrl: string;
  /** ローカルクローン親 (Memoria 解決用)。 リアクションワークフローの headless cwd に使う。 */
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
  /** Exact Discord user ID allowlist check for permission-skipping reaction workflows. */
  isReactionWorkflowUserAllowed?: (userId: string) => boolean;
  runHeadless: DiscordHeadlessRunner;
  repinSession: DiscordRepinSession;
  /**
   * Override for workflow-triggered session injects. In the embedded backend
   * this is the in-process event bus. In the standalone Discord worker it
   * posts to the backend API so the session WS receives the inject.
   */
  emitSessionInject?: (sessionId: string, text: string, source: string) => void;
  /**
   * 実効接続設定を解決する関数 (DB+env)。 start のたびに呼ぶので、 設定変更後の
   * restart で即反映される。 省略時は env (CONCORDIA_DISCORD_*) のみ。
   */
  resolveConfig?: () => DiscordEnv;
  onRuntimeState?: (state: { running: boolean; status: string; error?: string }) => void;
  /**
   * 子会社モード。 指定すると:
   *  - config / session-channels を `sub:<id>` scope で namespacing (本社と混ざらない)。
   *  - その子会社が起こしたセッションのみ 3 カテゴリに写す (subsidiary-only 可視)。
   *  - 出張先からの作業指示をガードゲートに通す (intake チャンネル → 専用 delegation)。
   *  - bot 自身のメンションを抑制 (高頻度カテゴリのデフォルト通知ミュート)。
   * spec/feature/subsidiary-delegation.md §3。
   */
  subsidiary?: {
    id: string;
    /** intake (受付) チャンネル id。 ここへの新規メッセージ = 修正依頼。 */
    intakeChannelId: string | null;
    /** 依頼 1 件をガード→記録→delegation まで処理し replyText を返す。 */
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    /** 当該ユーザがロック済みか。 */
    isLocked: (userId: string) => boolean;
  };
  /**
   * 本社内の軽量窓口 (desk)。 子会社と違い **本社 Bot にそのまま相乗り**する:
   * scope / 可視範囲 / レイアウトは本社のままで、 「タスク依頼」チャンネルを 1 本作り、
   * そこへの投稿だけを子会社と同じガードゲートに通す。 Bot は新たに接続しない。
   * spec/feature/subsidiary-delegation.md §9。
   */
  desk?: {
    id: string;
    /** 依頼チャンネル名 (既定「タスク依頼」)。 */
    channelName: string;
    /** 手動指定の channel_id (あれば自動作成せずこれを使う)。 */
    channelId: string | null;
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    isLocked: (userId: string) => boolean;
    /** 自動作成で解決した channel id を永続化するための通知。 */
    onChannelResolved?: (channelId: string) => void;
  };
}

export type DiscordBotHandle = ChatPlatform;

export async function startDiscordBot(deps: DiscordBotDeps): Promise<ChatPlatform | null> {
  const env = deps.resolveConfig ? deps.resolveConfig() : readDiscordEnv();
  if (!env.enabled) {
    log.info("discord disabled (enabled != 1); skip");
    return null;
  }
  if (!env.token || !env.guildId) {
    log.warn("discord token / guild_id missing (設定ページ or CONCORDIA_DISCORD_*); skip");
    return null;
  }

  // 子会社 scope: config / session-channels の namespacing と subsidiary-only 可視に使う。
  const scope = deps.subsidiary ? `sub:${deps.subsidiary.id}` : "";
  const subsidiaryId = deps.subsidiary?.id ?? null;
  // 本社 Bot と子会社 Bot は同一 token を共有するため、 各 Client は **全 guild** の
  // gateway イベントを受信してしまう。 そのまま処理すると interaction の二重 ack
  // (Unknown interaction / already acknowledged) や、 子会社 guild の /spawn を本社
  // Client が拾って本社側にセッションを作る、 等が起きる。 自分の guild 以外のイベントは
  // 全ハンドラ入口で捨てる (guildId が無い DM 等も対象外)。
  const inScope = (guildId: string | null | undefined): boolean => guildId === env.guildId;
  // 子会社は本社のような雑談 (meta) / pr-queue / errors を持たない slim 構成 (ユーザ要望)。
  const layoutOpts: EnsureLayoutOptions = {
    ...(deps.subsidiary
      ? { includeMetaChannels: false, includePrQueue: false, includeErrors: false }
      : {}),
    forumMode: env.forumMode !== false,
  };
  const workspaceRoots = deps.resolveWorkspaceRoots?.()
    ?? [deps.resolveWorkspaceRoot?.() || deps.workspaceRoot || process.cwd()];
  const projectResolver = createForumProjectResolver(workspaceRoots, log);
  // 受付 (intake) チャンネル: 手動 channel_id があればそれを優先 (override)、 無ければ
  // ClientReady で自動作成して埋める。 ingress のゲートはこの値で受付チャンネルを判定する。
  let subsidiaryIntakeChannelId: string | null = deps.subsidiary?.intakeChannelId ?? null;
  // 本社内 desk の依頼チャンネル。 子会社の受付と同じく手動 id 優先 → 無ければ ClientReady で自動作成。
  let deskChannelId: string | null = deps.desk?.channelId ?? null;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildWebhooks,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    // 子会社 Bot は高頻度カテゴリのデフォルト通知ミュートのため、 bot 発メッセージの
    // メンションを既定で一切解決しない (個別に上書きしない限り誰も ping しない)。
    ...(deps.subsidiary ? { allowedMentions: { parse: [] as never[] } } : {}),
  });

  const configRepo = makeDiscordConfigRepo(deps.db, scope);
  const sessionChannelsRepo = makeDiscordSessionChannelsRepo(deps.db, scope);
  const delegationRepo = new DelegationRepo(deps.db);
  // このセッションがこの Bot の可視範囲 (subsidiary-only / 本社) に属するか。
  // 子会社 Bot は metadata.subsidiary_id 一致のみ、 本社 Bot は subsidiary_id 無しのみ写す。
  const ownsSession = (sessionId: string): boolean => {
    const sid = deps.readModel.getSessionRelayState(sessionId)?.subsidiaryId ?? null;
    return subsidiaryId ? sid === subsidiaryId : !sid;
  };
  const isActiveDiscordSession = (sessionId: string): boolean => {
    const session = deps.readModel.getSessionRelayState(sessionId);
    const row = sessionChannelsRepo.findBySessionId(sessionId);
    return isActiveRelayTarget(session?.status ?? null, row?.status ?? null);
  };
  const messageMap = makeDiscordMessageMapRepo(deps.db);
  const reactionsRepo = makeChatMessageReactionsRepo(deps.db);
  const pendingQuestionsRepo = makeDiscordPendingQuestionsRepo(deps.db);
  const permissionActions: PermissionActionStore = new Map();

  // リアクションワークフロー: runner は常に構築し、 安全弁は handle() 内で live 評価。
  // → 設定 GUI トグルを bot 再起動なしで反映できる (OFF の間は handle が即 return)。
  const reactionWorkflow = new (getRwf().ReactionWorkflowRunner)({
    runHeadless: deps.runHeadless,
    emitInject: deps.emitSessionInject ?? ((sessionId, text, source) =>
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, ts: Math.floor(Date.now() / 1000) })),
    workspaceRoot: deps.resolveWorkspaceRoot?.() || deps.workspaceRoot || process.cwd(),
    workspaceRoots: deps.resolveWorkspaceRoots?.(),
    enabled: deps.resolveReactionWorkflowEnabled ?? (() => deps.reactionWorkflowEnabled ?? false),
    customMappings: deps.resolveReactionMappings,
    log,
  });
  const measuredHandleIngressMessage = instrumentDiscord("ingressMessage", handleIngressMessage);
  const measuredHandleReactionAdd = instrumentDiscord("reactionAdd", handleReactionAdd);
  const measuredHandleReactionRemove = instrumentDiscord("reactionRemove", handleReactionRemove);
  const measuredDispatchInteraction = instrumentDiscord("dispatchInteraction", dispatchInteraction);

  let layout: DiscordConfigSnapshot | null = null;
  let webhooks: WebhookPool | null = null;
  let activeGuild: Guild | null = null;
  let unsubscribe: (() => void) | null = null;
  let costTimer: ReturnType<typeof setInterval> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  let prQueueTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let staleChannelTimer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  let gatewayClosed = false;
  let reconcileRunning = false;
  const backgroundTimers = new Set<ReturnType<typeof setTimeout>>();
  // pr.changed event で即時再描画するための closure (ClientReady でセット).
  let prQueueRefresh: (() => void) | null = null;
  // error.reported を errors チャンネルへ転記する poster + Vestigium 監視.
  let errorPoster: ErrorChannelPoster | null = null;
  let errorMonitor: ErrorMonitorHandle | null = null;
  const promptRelayLast = new Map<string, { text: string; at: number }>();
  // 「作業中」インジケータ。ClientReady で guild を捕捉して生成する。
  let workingIndicator: WorkingIndicator | null = null;
  let channelWorkState: ChannelWorkState | null = null;
  const readPositiveIntEnv = (name: string, fallback: number, min = 1): number => {
    const raw = Number(process.env[name] ?? "");
    if (!Number.isFinite(raw) || raw <= 0) return Math.max(min, fallback);
    return Math.max(min, Math.floor(raw));
  };
  const readOptionalIntEnv = (name: string, fallback: number, min = 1): number => {
    const rawValue = process.env[name];
    if (rawValue == null || rawValue.trim() === "") return Math.max(0, fallback);
    const raw = Number(rawValue);
    if (!Number.isFinite(raw)) return Math.max(0, fallback);
    if (raw <= 0) return 0;
    return Math.max(min, Math.floor(raw));
  };
  const runWithConcurrency = async <T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!stopping) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await task(items[index]!);
      }
    });
    await Promise.all(workers);
  };
  const scheduleBackground = (label: string, fn: () => Promise<void> | void, delayMs: number): void => {
    const timer = setTimeout(() => {
      backgroundTimers.delete(timer);
      if (stopping) return;
      Promise.resolve(fn()).catch((e) => log.warn(`${label} failed: ${(e as Error).message}`));
    }, delayMs);
    timer.unref?.();
    backgroundTimers.add(timer);
  };
  const clearRuntimeTimers = (): void => {
    for (const timer of backgroundTimers) clearTimeout(timer);
    backgroundTimers.clear();
    if (costTimer) { clearInterval(costTimer); costTimer = null; }
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    if (prQueueTimer) { clearInterval(prQueueTimer); prQueueTimer = null; }
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    if (staleChannelTimer) { clearInterval(staleChannelTimer); staleChannelTimer = null; }
  };
  const stopAfterGatewayInstability = (status: string, error: string): void => {
    if (gatewayClosed || stopping) return;
    gatewayClosed = true;
    stopping = true;
    unsubscribe?.();
    unsubscribe = null;
    clearRuntimeTimers();
    errorMonitor?.stop();
    errorMonitor = null;
    const poster = errorPoster;
    errorPoster = null;
    if (poster) void poster.stop().catch(() => {});
    deps.onRuntimeState?.({ running: false, status, error });
    log.warn(`${status}: ${error}; stopped embedded Discord bot`);
    try { client.destroy(); } catch (e) { log.warn(`discord client destroy failed: ${(e as Error).message}`); }
  };

  client.once(Events.ClientReady, instrumentDiscord("ready", async (c) => {
    log.info(`logged in as ${c.user.tag}`);
    try {
      const guild = await c.guilds.fetch(env.guildId!);
      activeGuild = guild;
      await guild.channels.fetch();
      layout = await ensureDiscordLayout(guild, configRepo, layoutOpts);
      // 子会社モード: 受付チャンネルを自動作成 (手動 channel_id 指定がある場合はそれを優先)。
      if (deps.subsidiary) {
        try {
          if (!subsidiaryIntakeChannelId) {
            subsidiaryIntakeChannelId = await ensureIntakeChannel(guild, configRepo, layout.metaCategoryId);
            log.info(`subsidiary intake channel ensured id=${subsidiaryIntakeChannelId} guild=${guild.id}`);
          }
        } catch (e) {
          log.warn(`subsidiary intake channel ensure failed guild=${guild.id}: ${(e as Error).message}`);
        }
      }
      // 本社内 desk: 「タスク依頼」チャンネルを本社 guild に自動作成する。
      if (deps.desk) {
        try {
          if (!deskChannelId) {
            deskChannelId = await ensureDeskChannel(
              guild, configRepo, deps.desk.id, deps.desk.channelName, layout.metaCategoryId,
            );
            deps.desk.onChannelResolved?.(deskChannelId);
            log.info(`desk channel ensured id=${deskChannelId} name=${deps.desk.channelName} guild=${guild.id}`);
          }
        } catch (e) {
          log.warn(`desk channel ensure failed guild=${guild.id}: ${(e as Error).message}`);
        }
      }
      webhooks = new WebhookPool(guild, sessionChannelsRepo);
      if (env.applicationId) {
        try {
          if (deps.subsidiary) {
            // 子会社 guild は安全なセッション内操作だけ登録する。作業依頼 / spawn 系は
            // 引き続き受付チャンネルのメッセージ → ガードゲート経由に限定する。
            await registerGuildCommands(env.token!, env.applicationId, env.guildId!, { subsidiary: true });
            log.info(`slash commands registered (subsidiary allowed-only) guild=${env.guildId}`);
          } else {
            await registerGuildCommands(env.token!, env.applicationId, env.guildId!);
            log.info(`slash commands registered guild=${env.guildId}`);
          }
        } catch (e) {
          log.warn(`slash command registration failed guild=${env.guildId}: ${(e as Error).message}`);
        }
      } else {
        log.warn("CONCORDIA_DISCORD_APPLICATION_ID missing; slash commands are not registered");
      }
      scheduleBackground("delegation template cache prewarm", async () => {
        const templates = await prewarmDelegationTemplateCache(deps.concordiaUrl, log);
        log.info(`delegation template cache prewarmed templates=${templates.length}`);
      }, 100);
      void excubitorProjectCache
        .get(excubitorBaseUrl(), { info: (m) => log.info(m), warn: (m) => log.warn(m) })
        .catch((e) => log.warn(`excubitor project cache warmup failed: ${(e as Error).message}`));
      const costCh = guild.channels.cache.get(layout.costChannelId);
      if (costCh && costCh.type === ChannelType.GuildText) {
        const refresh = () => {
          const activityCh = guild.channels.cache.get(layout!.activityChannelId);
          return upsertCostChannelMessage(
            costCh,
            deps.readModel,
            (k) => configRepo.get(k),
            (k, v) => configRepo.set(k, v),
            activityCh?.type === ChannelType.GuildText ? activityCh : null,
          ).catch((e) => log.warn(`cost channel update failed: ${(e as Error).message}`));
        };
        const mins = readOptionalIntEnv("CONCORDIA_DISCORD_COST_REFRESH_MIN", 0, 1);
        if (mins > 0) {
          scheduleBackground("cost channel boot refresh", refresh, 1000);
          costTimer = setInterval(() => { void refresh(); }, mins * 60 * 1000);
          costTimer.unref?.();
        } else {
          log.info("cost channel refresh disabled");
        }
      } else {
        log.warn(`cost channel unavailable id=${layout.costChannelId}`);
      }
      // concordia-monitor: アクティブなセッション数 + 最終更新時間を定期更新.
      const refreshMonitor = instrumentDiscord("monitorRefresh", async () => {
        await guild.channels.fetch();
        layout = await ensureDiscordLayout(guild, configRepo, layoutOpts);
        const monitorCh = guild.channels.cache.get(layout.monitorChannelId);
        if (!monitorCh || monitorCh.type !== ChannelType.GuildText) {
          log.warn(`monitor channel unavailable id=${layout.monitorChannelId}`);
          return;
        }
        await upsertMonitorChannelMessage(
          monitorCh,
          deps.readModel.getMonitorSnapshot({
            subsidiaryId,
            costSubsidiaries: deps.subsidiary ? undefined : deps.listSubsidiaries?.(),
            channelForSession: (sessionId) => sessionChannelsRepo.findBySessionId(sessionId)?.channel_id ?? null,
          }),
          (k) => configRepo.get(k),
          (k, v) => configRepo.set(k, v),
          {
            stats: getEgressDedupStats(),
            // 本社モニターのみ本社/子会社別コストを出す (子会社 Bot では出さない)。
          },
        );
      });
      const monitorMins = readOptionalIntEnv("CONCORDIA_DISCORD_MONITOR_REFRESH_MIN", 0, 1);
      if (monitorMins > 0) {
        scheduleBackground("monitor channel boot refresh", refreshMonitor, 1000);
        monitorTimer = setInterval(() => {
          void refreshMonitor().catch((e) => log.warn(`monitor channel update failed: ${(e as Error).message}`));
        }, monitorMins * 60 * 1000);
        monitorTimer.unref?.();
      } else {
        log.info("monitor channel refresh disabled");
      }
      // pr-queue: 各セッションが作った PR のキューを定期更新 + pr.changed で即時再描画.
      const refreshPrQueue = instrumentDiscord("prQueueRefresh", async () => {
        await guild.channels.fetch();
        layout = await ensureDiscordLayout(guild, configRepo, layoutOpts);
        const prQueueCh = guild.channels.cache.get(layout.prQueueChannelId);
        if (!prQueueCh || prQueueCh.type !== ChannelType.GuildText) {
          log.warn(`pr-queue channel unavailable id=${layout.prQueueChannelId}`);
          return;
        }
        await upsertPrQueueChannelMessage(
          prQueueCh,
          deps.readModel.getPrQueueSnapshot({
            channelForSession: (sessionId) => {
              const ch = sessionChannelsRepo.findBySessionId(sessionId);
              if (!ch || ch.status === "ended") return null;
              return ch.channel_id;
            },
          }),
          (k) => configRepo.get(k),
          (k, v) => configRepo.set(k, v),
        );
      });
      // pr-queue を持たない構成 (子会社) では定期更新ごと skip する。
      const prMins = readOptionalIntEnv("CONCORDIA_DISCORD_PR_QUEUE_REFRESH_MIN", 0, 1);
      if (layout.prQueueChannelId && prMins > 0) {
        prQueueRefresh = () => { void refreshPrQueue(); };
        scheduleBackground("pr-queue channel boot refresh", refreshPrQueue, 1000);
        prQueueTimer = setInterval(() => {
          void refreshPrQueue().catch((e) => log.warn(`pr-queue channel update failed: ${(e as Error).message}`));
        }, prMins * 60 * 1000);
        prQueueTimer.unref?.();
      } else if (layout.prQueueChannelId) {
        log.info("pr-queue channel refresh disabled");
      }
      // errors チャンネル: error.reported を転記する poster + Vestigium 監視を起動.
      // errors を持たない構成 (子会社) では poster/監視を立てない (warn も出さない)。
      if (layout.errorChannelId) {
        const errorCh = guild.channels.cache.get(layout.errorChannelId);
        if (errorCh && errorCh.type === ChannelType.GuildText) {
          errorPoster = new ErrorChannelPoster(errorCh);
          errorPoster.start();
          errorMonitor = startVestigiumErrorWatch();
        } else {
          log.warn(`errors channel unavailable id=${layout.errorChannelId}`);
        }
      }
      // 状態カードは 3 タイミングのみ更新: spawn=作成 / 10分毎=更新 / Session-End=削除。
      // 10分毎: アクティブな session のカードは更新 (作成はしない)、 非アクティブは削除。
      const lay = layout;
      const statusSyncConcurrency = readPositiveIntEnv("CONCORDIA_DISCORD_STATUS_SYNC_CONCURRENCY", 2);
      const bootSyncDelayMs = readOptionalIntEnv("CONCORDIA_DISCORD_BOOT_SYNC_DELAY_MS", 0, 1000);
      const runStatusReconcile = instrumentDiscord("statusReconcile", async (reason: string): Promise<void> => {
        if (reconcileRunning) {
          log.info(`status-card ${reason} reconcile skipped; previous run still active`);
          return;
        }
        reconcileRunning = true;
        try {
          const lost = await reconcileLostStatusCards({ guild, configRepo, readModel: deps.readModel, log });
          log.info(`status-card ${reason} reconcile: scanned=${lost.scanned} removed=${lost.removed}`);
          const lostChannels = await reconcileLostSessionChannels({
            guild, layout: lay, repo: sessionChannelsRepo,
            isSessionLost: (sessionId) => deps.readModel.getSessionRelayState(sessionId)?.status === "lost",
            log,
          });
          if (lostChannels.reconciled > 0) {
            log.info(`session-channel lost ${reason} reconcile: scanned=${lostChannels.scanned} reconciled=${lostChannels.reconciled}`);
          }
          const activeRows = sessionChannelsRepo.listActive();
          await runWithConcurrency(activeRows, statusSyncConcurrency, async (row) => {
            await upsertSessionStatusCard({
              guild, layout: lay, configRepo, sessionChannelsRepo,
              readModel: deps.readModel, log,
            }, row.session_id, { allowCreate: true });
          });
          const pruned = await pruneStatusCategoryChannels({ guild, layout: lay, repo: sessionChannelsRepo, configRepo, log });
          if (pruned.deleted > 0) {
            log.info(`status-category ${reason} sweep: scanned=${pruned.scanned} deleted=${pruned.deleted}`);
          }
          const ended = await reconcileEndedSessionChannels({
            guild, layout: lay, repo: sessionChannelsRepo,
            isSessionEnded: (sessionId) => deps.readModel.getSessionRelayState(sessionId)?.status === "ended",
            log, webhooks: webhooks ?? undefined,
          });
          if (ended.reconciled > 0) {
            log.info(`session-channel ended ${reason} reconcile: scanned=${ended.scanned} reconciled=${ended.reconciled}`);
          }
        } finally {
          reconcileRunning = false;
        }
      });
      if (bootSyncDelayMs > 0) {
        scheduleBackground("status-card boot reconcile", () => runStatusReconcile("boot"), bootSyncDelayMs);
      } else {
        log.info("status-card boot reconcile disabled");
      }
      const reconcileSec = readOptionalIntEnv("CONCORDIA_DISCORD_STATUS_RECONCILE_SEC", 0, 60);
      if (reconcileSec > 0) {
        reconcileTimer = setInterval(() => {
          void runStatusReconcile("periodic").catch((e) => log.warn(`status-card periodic reconcile failed: ${(e as Error).message}`));
        }, reconcileSec * 1000);
        reconcileTimer.unref?.();
      } else {
        log.info("status-card periodic reconcile disabled");
      }
      // カテゴリ 50 チャンネル上限対策: 最終更新が 48h より前のチャンネルを
      // ログ保存してから削除する (sessions/archive カテゴリ、 稼働中は保護)。
      // 起動時に 1 回 + 以降 1 時間ごと。
      const runStaleSweep = instrumentDiscord("staleChannelSweep", async (): Promise<void> => {
        const r = await archiveStaleChannels({ guild, layout: layout!, repo: sessionChannelsRepo, log });
        log.info(`stale-channel sweep: scanned=${r.scanned} archived=${r.archived}`);
      });
      const staleBootDelayMs = readOptionalIntEnv("CONCORDIA_DISCORD_STALE_BOOT_SWEEP_DELAY_MS", 0, 1000);
      if (staleBootDelayMs > 0) {
        scheduleBackground("stale-channel boot sweep", runStaleSweep, staleBootDelayMs);
      } else {
        log.info("stale-channel boot sweep disabled");
      }
      const staleSweepSec = readOptionalIntEnv("CONCORDIA_DISCORD_STALE_SWEEP_SEC", 0, 60 * 60);
      if (staleSweepSec > 0) {
        staleChannelTimer = setInterval(() => {
          void runStaleSweep().catch((e) => log.warn(`stale-channel sweep failed: ${(e as Error).message}`));
        }, staleSweepSec * 1000);
        staleChannelTimer.unref?.();
      } else {
        log.info("stale-channel periodic sweep disabled");
      }
      // 「作業中」インジケータ: session channel に通常 bot メッセージとして出す
      // （webhook ではなく channel.send なので message.delete で確実に消せる）。
      const idleSec = Math.max(15, Number(process.env.CONCORDIA_DISCORD_WORKING_IDLE_SEC ?? "60") || 60);
      workingIndicator = new WorkingIndicator({
        idleMs: idleSec * 1000,
        log: (m) => log.info(`working-indicator: ${m}`),
        post: async (sessionId) => {
          const row = sessionChannelsRepo.findBySessionId(sessionId);
          if (!row || row.status !== "active") return null;
          const ch = guild.channels.cache.get(row.channel_id);
          if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.PublicThread)) return null;
          const m = await ch.send("🔄 **作業中…**");
          return m.id;
        },
        remove: async (sessionId, messageId) => {
          const row = sessionChannelsRepo.findBySessionId(sessionId);
          if (!row) return;
          const ch = guild.channels.cache.get(row.channel_id);
          if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.PublicThread)) return;
          try {
            const m = await ch.messages.fetch(messageId);
            await m.delete();
          } catch {
            // 既に消えている / 取得失敗は無視（best-effort）。
          }
        },
      });
      // 作業状態をチャンネル名の状態絵文字 (作業中⚙️ ⟷ 緑🟢) に反映するトラッカー。
      // idle 復帰は Discord の rename レート制限 (2回/10分) に合わせ 600 秒。
      const workIdleSec = Math.max(60, Number(process.env.CONCORDIA_DISCORD_WORK_IDLE_SEC ?? "600") || 600);
      channelWorkState = new ChannelWorkState({
        idleMs: workIdleSec * 1000,
        log: (m) => log.info(`channel-work-state: ${m}`),
        setWorking: (sessionId, working) => {
          void onSessionWorkState(
            { guild, layout: layout!, repo: sessionChannelsRepo, log },
            { sessionId, working },
          ).catch((e) => log.warn(`work-state rename failed session=${sessionId}: ${(e as Error).message}`));
        },
      });
      unsubscribe = eventBus.subscribe((ev) => routeEvent(ev, guild));
      deps.onRuntimeState?.({ running: true, status: "ready" });
    } catch (e) {
      const message = (e as Error).message;
      log.error(`ready handler failed: ${message}`);
      stopAfterGatewayInstability("ready_handler_failed", message);
    }
  }));

  client.on(Events.MessageCreate, instrumentDiscord("messageCreate", (msg) => {
    if (gatewayClosed || stopping) return;
    // 自分の guild 以外 (同一 token の本社/他子会社 Client にも届くイベント) は無視。
    if (!inScope(msg.guildId)) return;
    const raw = msg.content ?? "";
    const compact = raw.replace(/\s+/g, " ").trim();
    const preview = compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
    log.info(
      `message observed guild=${msg.guildId ?? "-"} channel=${msg.channelId} author=${msg.author?.id ?? "-"} ` +
      `bot=${msg.author?.bot ? 1 : 0} len=${raw.length} text="${preview}"`,
    );
    void measuredHandleIngressMessage({
      configRepo,
      sessionChannelsRepo,
      sessionsRepo: deps.sessionsRepo,
      concordiaUrl: deps.concordiaUrl,
      log,
      // 単発絵文字 (🙏 / 🫡 等) をリアクションワークフローに流すための解決系。
      chatRepo: deps.chatRepo,
      messageMap,
      workflow: reactionWorkflow,
      isWorkflowUserAllowed: deps.isReactionWorkflowUserAllowed,
      resolveReactionMappings: deps.resolveReactionMappings,
      // 窓口: 子会社 Bot なら受付チャンネル、 本社 Bot なら desk のタスク依頼チャンネル。
      // どちらも同じガードゲートに通す (ingress は種別を知らない)。 両方は同時に持たない
      // (子会社 Bot に desk は配線されない)。
      intake: resolveIntake(deps, subsidiaryIntakeChannelId, deskChannelId),
      subsidiary: Boolean(deps.subsidiary),
    }, msg).catch((e) => {
      log.warn(`ingress handler failed channel=${msg.channelId}: ${(e as Error).message}`);
    });
  }));

  client.on(Events.ThreadCreate, instrumentDiscord("threadCreate", (thread, newlyCreated) => {
    if (gatewayClosed || stopping || !newlyCreated || !layout?.forumMode) return;
    if (!inScope(thread.guildId)) return;
    void handleForumSpawnThread({
      sessionForumId: layout.sessionForumId,
      botUserId: client.user?.id ?? "",
      concordiaUrl: deps.concordiaUrl,
      templates: async () => (await delegationTemplateCache.get(deps.concordiaUrl, log)).templates,
      resolveProjectTarget: projectResolver.targetFromPost,
      hasExistingRun: (triggeredBy) => delegationRepo.findRunByTriggeredBy(triggeredBy) !== null,
      log,
    }, thread as unknown as ForumSpawnThread).catch((error) => {
      log.warn(`forum-spawn handler failed thread=${thread.id}: ${(error as Error).message}`);
    });
  }));

  client.on(Events.MessageReactionAdd, instrumentDiscord("reactionAddEvent", (reaction, user) => {
    if (gatewayClosed || stopping) return;
    if (!inScope(reaction.message.guildId)) return;
    void measuredHandleReactionAdd(
      {
        reactionsRepo,
        messageMap,
        log,
        workflow: reactionWorkflow,
        isWorkflowUserAllowed: deps.isReactionWorkflowUserAllowed,
        sessionChannels: sessionChannelsRepo,
        sessions: deps.sessionsRepo,
        repin: deps.repinSession,
      },
      reaction,
      user,
    ).catch((e) => {
      log.warn(`reaction add handler failed: ${(e as Error).message}`);
    });
  }));
  client.on(Events.MessageReactionRemove, instrumentDiscord("reactionRemoveEvent", (reaction, user) => {
    if (gatewayClosed || stopping) return;
    if (!inScope(reaction.message.guildId)) return;
    void measuredHandleReactionRemove({ reactionsRepo, messageMap, log }, reaction, user).catch((e) => {
      log.warn(`reaction remove handler failed: ${(e as Error).message}`);
    });
  }));
  client.on(Events.InteractionCreate, instrumentDiscord("interactionCreate", (interaction) => {
    if (gatewayClosed || stopping) return;
    startInteractionAckProbe(interaction, recordDiscordInteractionAck);
    // 自分の guild 以外の interaction は無視。 これをしないと同一 token の本社/子会社
    // Client が同じ interaction を二重 dispatch し、 片方が「Interaction has already
    // been acknowledged」/「Unknown interaction」になる。 また子会社 guild の /spawn を
    // 本社 Client が拾って本社側にセッションを作ってしまう。
    if (!inScope(interaction.guildId)) return;
    if (!layout) {
      // 起動/再起動直後は layout 未準備。 旧実装は黙って捨てて "This interaction failed"
      // に見えていた (spawn が効いたり効かなかったりする一因)。 明示的に案内する。
      if (interaction.isRepliable()) {
        void interaction.reply({ content: "Bot 起動処理中です。数秒後にもう一度お試しください。", ephemeral: true })
          .catch(() => { /* interaction expired; best-effort */ });
      }
      return;
    }
    void measuredDispatchInteraction(interaction, {
      concordiaUrl: deps.concordiaUrl,
      sessionsRepo: deps.sessionsRepo,
      sessionChannelsRepo,
      pendingQuestionsRepo,
      guild: interaction.guild!,
      layout,
      log,
      permissionActions,
      subsidiaryId,
      resolveWorkspaceRoots: deps.resolveWorkspaceRoots,
    }).catch((e) => {
      const age = interactionAgeMs(interaction);
      log.warn(
        `interaction handler failed id=${interaction.id} ${describeInteractionForLog(interaction)} ` +
        `age_ms=${age ?? "-"}: ${(e as Error).message}`,
      );
    });
  }));

  client.on(Events.Error, (e) => log.error(`client error: ${e.message}`));
  client.on(Events.Warn, (m) => log.warn(`client warn: ${m}`));
  client.on(Events.ShardError, (e, shardId) => {
    if (shouldRestartDiscordBot("error")) {
      stopAfterGatewayInstability("gateway_error", `shard=${shardId}: ${e.message}`);
    }
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    if (shouldRestartDiscordBot("disconnect")) {
      stopAfterGatewayInstability("gateway_disconnected", `shard=${shardId} code=${event.code} reason=${event.reason || "-"}`);
    }
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    // ShardReconnecting は discord.js が自力で resume する通常のライフサイクル
    // イベント。 ここで teardown すると一瞬のネットワーク揺らぎで bot が恒久停止
    // する (復帰経路なし) ため、 ログのみ残して resume に任せる。
    if (!shouldRestartDiscordBot("reconnecting")) {
      log.warn(`shard reconnecting shard=${shardId} (waiting for automatic resume)`);
    }
  });

  function routeEvent(ev: ConcordiaEvent, guild: import("discord.js").Guild): void {
    if (gatewayClosed || stopping) return;
    if (ev.type === "delegation.templates_changed") {
      log.info(
        `delegation template cache invalidated action=${ev.action} ` +
        `call_name=${ev.call_name ?? "-"} template_id=${ev.template_id ?? "-"}`,
      );
      void invalidateAndRefreshDelegationTemplateCache(deps.concordiaUrl, log)
        .then((templates) => log.info(`delegation template cache refreshed templates=${templates.length}`))
        .catch((e) => log.warn(`delegation template cache refresh after invalidate failed: ${(e as Error).message}`));
      return;
    }
    // error.reported は errors チャンネルへ (webhooks/layout 完備前でも poster があれば処理).
    if (ev.type === "error.reported") {
      errorPoster?.enqueue({ source: ev.source, message: ev.message, detail: ev.detail, ts: ev.ts });
      return;
    }
    if (!layout || !webhooks) return;

    // subsidiary-only 可視: このイベントが対象とするセッションが Bot の scope 外なら無視する
    // (本社 Bot は子会社セッションを写さず、 子会社 Bot は自分のセッションのみ写す)。
    const evSid = eventSessionId(ev);
    if (evSid !== null && !ownsSession(evSid)) return;

    if (ev.type === "session.started") {
      const state = deps.readModel.getSessionRelayState(ev.session_id);
      const sessionId = ev.session_id;
      const delegationRun = state?.delegationRunId ? delegationRepo.findRun(state.delegationRunId) : null;
      const forumSpawn = parseForumSpawnTrigger(delegationRun?.triggered_by);
      if (delegationRun && !layout.forumMode && (!forumSpawn || forumSpawn.guildId !== guild.id)) {
        log.info(
          `session.started delegation child: legacy layout has no TaskWorkflow surface session=${sessionId} ` +
          `run=${delegationRun.id} parent=${state?.delegationParentSessionId ?? "null"}`,
        );
        return;
      }
      void (async () => {
        try {
          const repoPath = state?.repoPath ?? ev.repo_path;
          const branch = state?.branch ?? ev.branch;
          if (forumSpawn) {
            const existing = sessionChannelsRepo.findBySessionId(sessionId);
            if (!existing) {
              const thread = await fetchForumSessionThread(guild, forumSpawn.threadId);
              if (!thread || thread.parentId !== layout.sessionForumId) {
                throw new Error(`spawn source thread is unavailable: ${forumSpawn.threadId}`);
              }
              const surfaceMessageId = await postForumSessionMetadata(guild, thread, {
                sessionId,
                repoPath,
                branch,
              });
              sessionChannelsRepo.upsert({
                session_id: sessionId,
                channel_id: thread.id,
                channel_kind: "thread",
                status: "active",
                display_state: "active",
                agent_type: ev.provider ?? null,
                name_body: state?.currentTask ?? state?.roleLabel ?? "session",
                delegation_emoji: state?.delegationEmoji ?? null,
                surface_message_id: surfaceMessageId,
              });
              await updateForumSessionState(thread, "active");
              log.info(`forum-spawn bound session=${sessionId} thread=${thread.id} run=${state?.delegationRunId}`);
            } else {
              log.info(`forum-spawn session already bound session=${sessionId} thread=${existing.channel_id}`);
            }
          } else {
            const surface = resolveForumSessionSurface(layout, delegationRun?.id);
            const surfaceLayout = { ...layout, sessionForumId: surface.forumId };
            await onSessionRegistered(
              { guild, layout: surfaceLayout, repo: sessionChannelsRepo, log, webhooks },
              {
                sessionId,
                agentType: ev.provider ?? null,
                delegationEmoji: state?.delegationEmoji ?? null,
                roleLabel: delegationRun?.call_name ?? state?.roleLabel ?? null,
                personaDisplayName: state?.personaDisplayName ?? null,
                repoPath,
                branch,
                currentTask: state?.currentTask ?? delegationRun?.call_name ?? null,
                projectCode: projectResolver.codeForRepo(repoPath),
                surfaceLabel: surface.label,
                delegationRunId: surface.delegationRunId,
              },
            );
            if (delegationRun) {
              log.info(`task-workflow bound session=${sessionId} run=${delegationRun.id}`);
            }
          }
          // channel 作成前に届いて「永続化のみ」になった frame を埋め戻す。
          // watermark (maxId) は channel 行作成後に取る — これ以降の frame は
          // relay gate を通ってライブ配信されるので replay 対象から外れる。
          if (deps.transcriptLogs) {
            const upToId = deps.transcriptLogs.maxId(sessionId);
            replayPersistedTranscript(
              { transcriptLogs: deps.transcriptLogs, log },
              sessionId,
              upToId,
            );
          }
          await upsertSessionStatusCard({
            guild,
            layout,
            configRepo,
            sessionChannelsRepo,
            readModel: deps.readModel,
            log,
          }, sessionId, { allowCreate: true });
          // 状態カード作成後、セッションチャンネルの topic を状態カードリンクにする。
          const statusChannelId = getStatusChannelId(configRepo, sessionId);
          if (statusChannelId) {
            const sessionRow = sessionChannelsRepo.findBySessionId(sessionId);
            if (sessionRow) {
              await updateSessionSurfaceMetadata(
                { guild, layout, repo: sessionChannelsRepo, log },
                {
                  sessionId,
                  repoPath,
                  branch,
                  statusCardChannelId: statusChannelId,
                  surfaceLabel: delegationRun ? "TaskWorkflow" : "Session",
                  delegationRunId: delegationRun?.id ?? null,
                },
              ).catch((e: unknown) => log.warn(`session-forum: starter update failed ${sessionId}: ${(e as Error).message}`));
              const ch = guild.channels.cache.get(sessionRow.channel_id);
              if (ch && ch.type === ChannelType.GuildText) {
                await ch.edit({
                  topic: `https://discord.com/channels/${guild.id}/${statusChannelId}`,
                  reason: `session status card link for ${sessionId}`,
                }).catch((e: unknown) => log.warn(`session-channel: topic link failed ${sessionId}: ${(e as Error).message}`));
              }
            }
          }
        } catch (e) {
          log.warn(`session.started handler failed ${sessionId}: ${(e as Error).message}`);
        }
      })();
      return;
    }
    if (ev.type === "session.lost") {
      workingIndicator?.clear(ev.session_id);
      channelWorkState?.clear(ev.session_id);
      void onSessionStatusChanged({ guild, layout, repo: sessionChannelsRepo, log }, { sessionId: ev.session_id, status: "lost" });
      // lost = wrapper の heartbeat が止まった (端末を閉じた等で実質終了)。 状態カードは
      // グレーで残さず即削除する。 旧実装は upsert でグレー化して残し、 削除は 1 時間ごとの
      // reconcileLostStatusCards 任せだったため「終わったセッションのカードが最大 1h 居座る」
      // 状態だった。 もし lost から復帰 (resume) すれば session.started で新規カードが立つ。
      void deleteSessionStatusCard({ guild, configRepo, log }, ev.session_id)
        .catch((e) => log.warn(`status-card delete on lost failed session=${ev.session_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "session.ended") {
      workingIndicator?.clear(ev.session_id);
      channelWorkState?.clear(ev.session_id);
      void onSessionStatusChanged({ guild, layout, repo: sessionChannelsRepo, log, webhooks: webhooks ?? undefined }, { sessionId: ev.session_id, status: "ended" });
      // End-Session: 会話チャンネル削除 (onSessionStatusChanged) に加え、状態カードも削除する。
      void deleteSessionStatusCard({ guild, configRepo, log }, ev.session_id)
        .catch((e) => log.warn(`status-card delete on ended failed session=${ev.session_id}: ${(e as Error).message}`));
      return;
    }
    // stat.collected での状態カード更新は撤去 (更新は 10 分毎の定期 tick のみ)。
    if (ev.type === "pr.changed") {
      // ingest / reconcile で PR キューが動いたら pr-queue チャンネルを即時更新.
      prQueueRefresh?.();
      return;
    }
    if (ev.type === "delegation.mirror") {
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      void (async () => {
        const client = await webhooks.getForSession(ev.target_session_id);
        if (!client) return;
        await webhooks.send(client, { content: ev.text.slice(0, 1900), username: "Cc delegation" });
      })().catch((e) => log.warn(`delegation mirror post failed session=${ev.target_session_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "taskflow.user_decision") {
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      void (async () => {
        const client = await webhooks.getForSession(ev.target_session_id);
        if (!client) return;
        const mention = ev.mention_user_id ? `<@${ev.mention_user_id}> ` : "";
        await webhooks.send(client, {
          content: `${mention}${ev.text}`.slice(0, 1900),
          username: "Cc taskflow",
          allowedMentions: ev.mention_user_id ? { users: [ev.mention_user_id] } : { parse: [] },
        });
      })().catch((e) => log.warn(`taskflow decision post failed: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "chat.posted" || ev.type === "transcript.frame") {
      handleEgressEvent({
        guild,
        layout,
        webhooks,
        readModel: deps.readModel,
        sessionChannelsRepo,
        messageMap,
        messageOptimizationEnabled: env.messageOptimizationEnabled,
        log,
      }, ev);
      // transcript が動いている = セッションは作業中。進捗ごとに「作業中」を消して
      // 落ち着いたら最下部へ出し直す（idle で除去）。session に紐づくものだけ。
      const progressSession =
        ev.type === "transcript.frame" ? ev.target_session_id : ev.session_id ?? null;
      if (progressSession && isActiveDiscordSession(progressSession)) {
        workingIndicator?.noteProgress(progressSession);
        channelWorkState?.noteProgress(progressSession);
      }
      // 指示 (Discord inject) → transcript が動いた最初のタイミングで ✅ を付ける。
      // takeInjectAck は delete-on-read なので、 後続フレームや codex prompt 経路と
      // 二重に付かない。 Enter 未送信で transcript が動かなければ ✅ は付かない。
      if (ev.type === "transcript.frame") {
        const ack = takeInjectAck(ev.target_session_id);
        if (ack) {
          void (async () => {
            try {
              const channel = guild.channels.cache.get(ack.channelId);
              if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread)) return;
              const m = await channel.messages.fetch(ack.messageId);
              await m.react("✅");
            } catch (e) {
              log.warn(`inject-ack: react failed session=${ev.target_session_id}: ${(e as Error).message}`);
            }
          })();
        }
      }
      return;
    }
    if (ev.type === "session.event" && ev.kind === "prompt") {
      // 指令を受け付けた = 作業開始。出力が来る前から「作業中」を出す。
      const prompt = deps.readModel.getSessionPromptEvent(ev.session_id);
      if (!prompt || !shouldRelaySessionPromptToDiscord(prompt.provider)) return;
      const row = sessionChannelsRepo.findBySessionId(ev.session_id);
      if (!isActiveRelayTarget(prompt.status, row?.status ?? null)) return;
      workingIndicator?.noteProgress(ev.session_id);
      channelWorkState?.noteProgress(ev.session_id);
      const text = prompt.text;
      const source = prompt.source;
      if (!text) return;
      // Discord session channel からの inject は元メッセージがすでに表示済み。
      // ここで再 relay すると Codex だけ二重投稿になりやすいため除外する。
      if (parseInjectSource(source).platform === "discord" || source === "discord-enter" || source === "discord-enter-fallback") {
        // codex: prompt が受理された = transcript が動いた。 保留中の ✅ を 1 回だけ付ける
        // (takeInjectAck は delete-on-read なので transcript.frame 経路と二重にならない)。
        const ack = takeInjectAck(ev.session_id);
        if (ack) {
          void (async () => {
            try {
              const channel = guild.channels.cache.get(ack.channelId);
              if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread)) return;
              const m = await channel.messages.fetch(ack.messageId);
              await m.react("✅");
            } catch (e) {
              log.warn(`inject-ack: codex react failed session=${ev.session_id}: ${(e as Error).message}`);
            }
          })();
        }
        return;
      }
      const now = Date.now();
      const prev = promptRelayLast.get(ev.session_id);
      if (prev && prev.text === text && now - prev.at < 60_000) {
        log.info(`prompt relay: dedup skipped session=${ev.session_id}`);
        return;
      }
      void (async () => {
        const client = await webhooks.getForSession(ev.session_id);
        if (!client) {
          log.warn(`prompt relay: webhook missing session=${ev.session_id}`);
          return;
        }
        const msg = text.length > 1900 ? `${text.slice(0, 1900)}...` : text;
        const sent = await webhooks.send(client, { content: msg, username: "CLI User" });
        if (!sent) {
          log.warn(`prompt relay: send failed session=${ev.session_id}`);
          return;
        }
        promptRelayLast.set(ev.session_id, { text, at: now });
        log.info(`prompt relay: sent session=${ev.session_id} event_ts=${ev.ts}`);
      })().catch((e) => log.warn(`prompt relay failed session=${ev.session_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "session.event" && ev.kind === "title_renamed") {
      const titleEvent = deps.readModel.getSessionTitleEvent(ev.session_id);
      if (!isActiveDiscordSession(ev.session_id)) return;
      if (titleEvent) {
        // title-suggestion (AI 自動) はチャンネル名を変えない。手動/リアクション rename のみ反映。
        const forceRename = titleEvent.source !== "title-suggestion";
        void onSessionTitleChanged(
          { guild, layout, repo: sessionChannelsRepo, log },
          {
            sessionId: ev.session_id,
            title: titleEvent.title,
            agentType: titleEvent.provider,
            forceRename,
            projectCode: projectResolver.codeForRepo(deps.readModel.getSessionRelayState(ev.session_id)?.repoPath ?? ""),
          },
        );
      }
      return;
    }
    if (ev.type === "session.event" && ev.kind === "branch_changed") {
      const state = deps.readModel.getSessionRelayState(ev.session_id);
      if (!state) return;
      const delegationRun = state.delegationRunId ? delegationRepo.findRun(state.delegationRunId) : null;
      void updateSessionSurfaceMetadata(
        { guild, layout, repo: sessionChannelsRepo, log },
        {
          sessionId: ev.session_id,
          repoPath: state.repoPath,
          branch: state.branch,
          statusCardChannelId: getStatusChannelId(configRepo, ev.session_id),
          surfaceLabel: delegationRun ? "TaskWorkflow" : "Session",
          delegationRunId: delegationRun?.id ?? null,
        },
      ).catch((e) => log.warn(`session-forum: branch update failed ${ev.session_id}: ${(e as Error).message}`));
      return;
    }
    // task_update での状態カード即時更新は撤去 (更新は 10 分毎の定期 tick のみ)。
    if (ev.type === "question.posted") {
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      void postQuestion({ guild, sessionChannelsRepo, pendingQuestionsRepo, log }, ev);
      return;
    }
    if (ev.type === "session.permission_request") {
      if (!shouldPostPermissionRequestToDiscord(env)) return;
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      void postPermissionRequest({ guild, sessionChannelsRepo, permissionActions, log }, ev)
        .catch((e) => log.warn(`permission request post failed session=${ev.target_session_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "question.resolved") {
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      // picker がローカル回答で解決 → 投稿済み質問のボタンを外す（再クリック防止）。
      void resolveQuestionMessage({ guild, sessionChannelsRepo, pendingQuestionsRepo, log }, ev);
      return;
    }
    if (ev.type === "session.inject") {
      // 環境同期: 相手プラットフォーム(Slack)由来の inject を Discord の session channel
      // にも発言者付きで転記する。Discord 由来は元発言が既に表示済なので転記しない。
      // 制御 inject (/enter 等、source 例 "discord-enter") は ^slack: に一致せず除外。
      const src = ev.source ?? "";
      if (parseInjectSource(src).platform !== "slack") return;
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      const who = ev.author_label?.trim() || "Slack user";
      void (async () => {
        const client = await webhooks.getForSession(ev.target_session_id);
        if (!client) return;
        await webhooks.send(client, { content: ev.text.slice(0, 1900), username: `🔁 Slack / ${who}` });
      })().catch((e) => log.warn(`slack inject mirror failed session=${ev.target_session_id}: ${(e as Error).message}`));
    }
  }

  await client.login(env.token);
  if (gatewayClosed) throw new Error("discord gateway closed during startup");

  return {
    name: "discord",
    async postToSession(input) {
      if (gatewayClosed || stopping || !webhooks) return;
      const client = await webhooks.getForSession(input.sessionId);
      if (!client) return;
      await webhooks.send(client, {
        content: input.text,
        username: input.authorLabel?.trim() || "Concordia",
      });
    },
    async ensureSessionSurface(sessionId) {
      if (gatewayClosed || stopping || !activeGuild || !layout) return;
      const state = deps.readModel.getSessionRelayState(sessionId);
      await onSessionRegistered(
        { guild: activeGuild, layout, repo: sessionChannelsRepo, log, webhooks: webhooks ?? undefined },
        {
          sessionId,
          agentType: state?.provider ?? null,
          delegationEmoji: state?.delegationEmoji ?? null,
          roleLabel: state?.roleLabel ?? null,
          personaDisplayName: state?.personaDisplayName ?? null,
          repoPath: state?.repoPath ?? null,
          branch: state?.branch ?? null,
          currentTask: state?.currentTask ?? null,
          projectCode: state?.repoPath ? projectResolver.codeForRepo(state.repoPath) : null,
        },
      );
      await upsertSessionStatusCard({
        guild: activeGuild,
        layout,
        configRepo,
        sessionChannelsRepo,
        readModel: deps.readModel,
        log,
      }, sessionId, { allowCreate: true });
      if (state) {
        const delegationRun = state.delegationRunId ? delegationRepo.findRun(state.delegationRunId) : null;
        await updateSessionSurfaceMetadata(
          { guild: activeGuild, layout, repo: sessionChannelsRepo, log },
          {
            sessionId,
            repoPath: state.repoPath,
            branch: state.branch,
            statusCardChannelId: getStatusChannelId(configRepo, sessionId),
            surfaceLabel: delegationRun ? "TaskWorkflow" : "Session",
            delegationRunId: delegationRun?.id ?? null,
          },
        ).catch((e) => log.warn(`session-forum: starter update failed ${sessionId}: ${(e as Error).message}`));
      }
    },
    async postQuestion(input) {
      if (gatewayClosed || stopping || !activeGuild) return;
      await postQuestion(
        { guild: activeGuild, sessionChannelsRepo, pendingQuestionsRepo, log },
        { target_session_id: input.target_session_id, question_id: input.question_id, question: input.question, options: input.options },
      );
    },
    async relayFrame(input) {
      if (gatewayClosed || stopping || !activeGuild || !layout || !webhooks) return;
      handleEgressEvent({
        guild: activeGuild,
        layout,
        webhooks,
        readModel: deps.readModel,
        sessionChannelsRepo,
        messageMap,
        messageOptimizationEnabled: env.messageOptimizationEnabled,
        log,
      }, {
        type: "transcript.frame",
        target_session_id: input.target_session_id,
        kind: input.kind as never,
        payload: input.payload as never,
        seq: input.seq ?? 0,
        ts: Math.floor(Date.now() / 1000),
      });
    },
    async stop() {
      stopping = true;
      unsubscribe?.();
      unsubscribe = null;
      clearRuntimeTimers();
      errorMonitor?.stop();
      errorMonitor = null;
      if (errorPoster) { try { await errorPoster.stop(); } catch {} }
      errorPoster = null;
      try { await client.destroy(); } catch {}
      deps.onRuntimeState?.({ running: false, status: "stopped" });
    },
  };
}


/**
 * この Bot が見張る依頼窓口 (ingress の intake) を解決する。 子会社 Bot は自分の受付
 * チャンネル、 本社 Bot は desk のタスク依頼チャンネル。 どちらも無ければ窓口なし。
 */
function resolveIntake(
  deps: DiscordBotDeps,
  subsidiaryIntakeChannelId: string | null,
  deskChannelId: string | null,
): { intakeChannelId: string | null; process: (u: string, l: string, i: string) => Promise<{ replyText: string }>; isLocked: (u: string) => boolean } | undefined {
  if (deps.subsidiary) {
    return {
      intakeChannelId: subsidiaryIntakeChannelId,
      process: deps.subsidiary.process,
      isLocked: deps.subsidiary.isLocked,
    };
  }
  if (deps.desk) {
    return {
      intakeChannelId: deskChannelId,
      process: deps.desk.process,
      isLocked: deps.desk.isLocked,
    };
  }
  return undefined;
}

/** session-scoped イベントの対象 session id を返す (subsidiary-only 可視のゲート用)。 非該当は null。 */
function eventSessionId(ev: ConcordiaEvent): string | null {
  switch (ev.type) {
    case "session.started":
    case "session.lost":
    case "session.ended":
    case "session.event":
      return ev.session_id;
    case "transcript.frame":
    case "session.inject":
    case "session.permission_request":
    case "delegation.mirror":
    case "question.posted":
    case "question.resolved":
      return ev.target_session_id;
    case "chat.posted":
      return ev.session_id ?? null;
    default:
      return null;
  }
}
