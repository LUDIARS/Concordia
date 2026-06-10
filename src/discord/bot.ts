import { ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Database } from "better-sqlite3";
import type { ChatRepo } from "../db/chat-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import {
  makeChatMessageReactionsRepo,
  makeDiscordConfigRepo,
  makeDiscordMessageMapRepo,
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import { ensureDiscordLayout, type DiscordConfigSnapshot } from "./config.js";
import { getEgressDedupStats, handleEvent as handleEgressEvent } from "./egress.js";
import { handleMessage as handleIngressMessage } from "./ingress.js";
import { handleReactionAdd, handleReactionRemove } from "./reactions.js";
import { ReactionWorkflowRunner, type WorkflowAction } from "../platform/reaction-workflow.js";
import { runClaude } from "../rules/claude-runner.js";
import {
  onSessionRegistered,
  onSessionStatusChanged,
  onSessionTitleChanged,
  onSessionWorkState,
  pruneStatusCategoryChannels,
  archiveStaleChannels,
} from "./session-channel.js";
import { ChannelWorkState } from "./channel-work-state.js";
import { upsertSessionStatusCard, deleteSessionStatusCard, reconcileLostStatusCards } from "./session-status-card.js";
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
import { postQuestion, resolveQuestionMessage } from "./question.js";
import { createChildLogger } from "../shared/logger.js";
import { WorkingIndicator } from "../platform/working-indicator.js";

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

export interface DiscordBotDeps {
  db: Database;
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  sessionTaskRecordsRepo: SessionTaskRecordsRepo;
  /** Concordia の依頼 (chat-reply / title-suggest 等の pending tasks) の集計に使う. */
  tasksRepo: TasksRepo;
  personasRepo: PersonasRepo;
  /** PR キューの自動更新メッセージ / pr.changed 再描画に使う. */
  prRecordsRepo: PrRecordsRepo;
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
  /**
   * 実効接続設定を解決する関数 (DB+env)。 start のたびに呼ぶので、 設定変更後の
   * restart で即反映される。 省略時は env (CONCORDIA_DISCORD_*) のみ。
   */
  resolveConfig?: () => DiscordEnv;
}

export interface DiscordBotHandle {
  stop(): Promise<void>;
}

export async function startDiscordBot(deps: DiscordBotDeps): Promise<DiscordBotHandle | null> {
  const env = deps.resolveConfig ? deps.resolveConfig() : readDiscordEnv();
  if (!env.enabled) {
    log.info("discord disabled (enabled != 1); skip");
    return null;
  }
  if (!env.token || !env.guildId) {
    log.warn("discord token / guild_id missing (設定ページ or CONCORDIA_DISCORD_*); skip");
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildWebhooks,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });

  const configRepo = makeDiscordConfigRepo(deps.db);
  const sessionChannelsRepo = makeDiscordSessionChannelsRepo(deps.db);
  const messageMap = makeDiscordMessageMapRepo(deps.db);
  const reactionsRepo = makeChatMessageReactionsRepo(deps.db);
  const pendingQuestionsRepo = makeDiscordPendingQuestionsRepo(deps.db);

  // リアクションワークフロー: runner は常に構築し、 安全弁は handle() 内で live 評価。
  // → 設定 GUI トグルを bot 再起動なしで反映できる (OFF の間は handle が即 return)。
  const reactionWorkflow = new ReactionWorkflowRunner({
    runHeadless: runClaude,
    workspaceRoot: deps.resolveWorkspaceRoot?.() || deps.workspaceRoot || process.cwd(),
    workspaceRoots: deps.resolveWorkspaceRoots?.(),
    enabled: deps.resolveReactionWorkflowEnabled ?? (() => deps.reactionWorkflowEnabled ?? false),
    customMappings: deps.resolveReactionMappings,
    log,
  });

  let layout: DiscordConfigSnapshot | null = null;
  let webhooks: WebhookPool | null = null;
  let unsubscribe: (() => void) | null = null;
  let costTimer: ReturnType<typeof setInterval> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  let prQueueTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let staleChannelTimer: ReturnType<typeof setInterval> | null = null;
  // pr.changed event で即時再描画するための closure (ClientReady でセット).
  let prQueueRefresh: (() => void) | null = null;
  // error.reported を errors チャンネルへ転記する poster + Vestigium 監視.
  let errorPoster: ErrorChannelPoster | null = null;
  let errorMonitor: ErrorMonitorHandle | null = null;
  const promptRelayLast = new Map<string, { text: string; at: number }>();
  // 「作業中」インジケータ。ClientReady で guild を捕捉して生成する。
  let workingIndicator: WorkingIndicator | null = null;
  let channelWorkState: ChannelWorkState | null = null;

  client.once(Events.ClientReady, async (c) => {
    log.info(`logged in as ${c.user.tag}`);
    try {
      const guild = await c.guilds.fetch(env.guildId!);
      await guild.channels.fetch();
      layout = await ensureDiscordLayout(guild, configRepo);
      webhooks = new WebhookPool(guild, sessionChannelsRepo);
      if (env.applicationId) {
        await registerGuildCommands(env.token!, env.applicationId, env.guildId!);
      } else {
        log.warn("CONCORDIA_DISCORD_APPLICATION_ID missing; slash commands are not registered");
      }
      const costCh = guild.channels.cache.get(layout.costChannelId);
      if (costCh && costCh.type === ChannelType.GuildText) {
        const refresh = () => {
          const activityCh = guild.channels.cache.get(layout!.activityChannelId);
          return upsertCostChannelMessage(
            costCh,
            deps.sessionsRepo,
            (k) => configRepo.get(k),
            (k, v) => configRepo.set(k, v),
            activityCh?.type === ChannelType.GuildText ? activityCh : null,
          ).catch((e) => log.warn(`cost channel update failed: ${(e as Error).message}`));
        };
        void refresh();
        const mins = Math.max(10, Number(process.env.CONCORDIA_DISCORD_COST_REFRESH_MIN ?? "10") || 10);
        costTimer = setInterval(() => { void refresh(); }, mins * 60 * 1000);
        costTimer.unref?.();
      } else {
        log.warn(`cost channel unavailable id=${layout.costChannelId}`);
      }
      // concordia-monitor: アクティブなセッション数 + 最終更新時間を定期更新.
      const refreshMonitor = async () => {
        await guild.channels.fetch();
        layout = await ensureDiscordLayout(guild, configRepo);
        const monitorCh = guild.channels.cache.get(layout.monitorChannelId);
        if (!monitorCh || monitorCh.type !== ChannelType.GuildText) {
          log.warn(`monitor channel unavailable id=${layout.monitorChannelId}`);
          return;
        }
        await upsertMonitorChannelMessage(
          monitorCh,
          deps.sessionsRepo,
          deps.sessionTaskRecordsRepo,
          (k) => configRepo.get(k),
          (k, v) => configRepo.set(k, v),
          getEgressDedupStats(),
        );
      };
      void refreshMonitor().catch((e) => log.warn(`monitor channel update failed: ${(e as Error).message}`));
      const monitorMins = Math.max(10, Number(process.env.CONCORDIA_DISCORD_MONITOR_REFRESH_MIN ?? "10") || 10);
      monitorTimer = setInterval(() => {
        void refreshMonitor().catch((e) => log.warn(`monitor channel update failed: ${(e as Error).message}`));
      }, monitorMins * 60 * 1000);
      monitorTimer.unref?.();
      // pr-queue: 各セッションが作った PR のキューを定期更新 + pr.changed で即時再描画.
      const refreshPrQueue = async () => {
        await guild.channels.fetch();
        layout = await ensureDiscordLayout(guild, configRepo);
        const prQueueCh = guild.channels.cache.get(layout.prQueueChannelId);
        if (!prQueueCh || prQueueCh.type !== ChannelType.GuildText) {
          log.warn(`pr-queue channel unavailable id=${layout.prQueueChannelId}`);
          return;
        }
        await upsertPrQueueChannelMessage(
          prQueueCh,
          deps.prRecordsRepo,
          sessionChannelsRepo,
          (k) => configRepo.get(k),
          (k, v) => configRepo.set(k, v),
        );
      };
      {
        prQueueRefresh = () => { void refreshPrQueue(); };
        void refreshPrQueue().catch((e) => log.warn(`pr-queue channel update failed: ${(e as Error).message}`));
        const prMins = Math.max(10, Number(process.env.CONCORDIA_DISCORD_PR_QUEUE_REFRESH_MIN ?? "15") || 15);
        prQueueTimer = setInterval(() => {
          void refreshPrQueue().catch((e) => log.warn(`pr-queue channel update failed: ${(e as Error).message}`));
        }, prMins * 60 * 1000);
        prQueueTimer.unref?.();
      }
      // errors チャンネル: error.reported を転記する poster + Vestigium 監視を起動.
      const errorCh = guild.channels.cache.get(layout.errorChannelId);
      if (errorCh && errorCh.type === ChannelType.GuildText) {
        errorPoster = new ErrorChannelPoster(errorCh);
        errorPoster.start();
        errorMonitor = startVestigiumErrorWatch();
      } else {
        log.warn(`errors channel unavailable id=${layout.errorChannelId}`);
      }
      // 状態カードは 3 タイミングのみ更新: spawn=作成 / 10分毎=更新 / Session-End=削除。
      // 10分毎: アクティブな session のカードは更新 (作成はしない)、 非アクティブは削除。
      const lay = layout;
      reconcileTimer = setInterval(() => {
        // 非アクティブ (lost/ended/消滅) の状態カードを削除。
        void reconcileLostStatusCards({ guild, configRepo, sessionsRepo: deps.sessionsRepo, log })
          .then((r) => log.info(`status-card reconcile: scanned=${r.scanned} removed=${r.removed}`))
          .catch((e) => log.warn(`status-card reconcile failed: ${(e as Error).message}`));
        // アクティブな session のカードのみ更新 (allowCreate=false なので作り直しはしない)。
        for (const row of sessionChannelsRepo.listActive()) {
          void upsertSessionStatusCard({
            guild, layout: lay, configRepo, sessionChannelsRepo,
            sessionsRepo: deps.sessionsRepo, sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
            tasksRepo: deps.tasksRepo, personasRepo: deps.personasRepo, log,
          }, row.session_id).catch((e) => log.warn(`status-card 10min update failed session=${row.session_id}: ${(e as Error).message}`));
        }
        void pruneStatusCategoryChannels({ guild, layout: lay, repo: sessionChannelsRepo, configRepo, log })
          .catch((e) => log.warn(`prune failed: ${(e as Error).message}`));
      }, 10 * 60 * 1000);
      reconcileTimer.unref?.();
      for (const row of sessionChannelsRepo.listActive()) {
        void upsertSessionStatusCard({
          guild,
          layout,
          configRepo,
          sessionChannelsRepo,
          sessionsRepo: deps.sessionsRepo,
          sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
          tasksRepo: deps.tasksRepo,
          personasRepo: deps.personasRepo,
          log,
        }, row.session_id);
      }
      // 起動時に状態カテゴリの orphan channel を一括掃除 (cost + session channel
      // + status-card channel 以外). configRepo を渡すのは status-card channel の
      // ID 一覧を読むため (これ無しだと稼働中 card を消して落ちる)。
      void pruneStatusCategoryChannels({ guild, layout, repo: sessionChannelsRepo, configRepo, log })
        .then((r) => log.info(`status-category sweep on boot: scanned=${r.scanned} deleted=${r.deleted}`))
        .catch((e) => log.warn(`status-category sweep on boot failed: ${(e as Error).message}`));
      // カテゴリ 50 チャンネル上限対策: 最終更新が 48h より前のチャンネルを
      // ログ保存してから削除する (sessions/archive カテゴリ、 稼働中は保護)。
      // 起動時に 1 回 + 以降 1 時間ごと。
      const runStaleSweep = () =>
        void archiveStaleChannels({ guild, layout: layout!, repo: sessionChannelsRepo, log })
          .then((r) => log.info(`stale-channel sweep: scanned=${r.scanned} archived=${r.archived}`))
          .catch((e) => log.warn(`stale-channel sweep failed: ${(e as Error).message}`));
      runStaleSweep();
      staleChannelTimer = setInterval(runStaleSweep, 60 * 60 * 1000);
      staleChannelTimer.unref?.();
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
          if (!ch || ch.type !== ChannelType.GuildText) return null;
          const m = await ch.send("🔄 **作業中…**");
          return m.id;
        },
        remove: async (sessionId, messageId) => {
          const row = sessionChannelsRepo.findBySessionId(sessionId);
          if (!row) return;
          const ch = guild.channels.cache.get(row.channel_id);
          if (!ch || ch.type !== ChannelType.GuildText) return;
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
    } catch (e) {
      log.error(`ready handler failed: ${(e as Error).message}`);
    }
  });

  client.on(Events.MessageCreate, (msg) => {
    const raw = msg.content ?? "";
    const compact = raw.replace(/\s+/g, " ").trim();
    const preview = compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
    log.info(
      `message observed guild=${msg.guildId ?? "-"} channel=${msg.channelId} author=${msg.author?.id ?? "-"} ` +
      `bot=${msg.author?.bot ? 1 : 0} len=${raw.length} text="${preview}"`,
    );
    void handleIngressMessage({
      configRepo,
      sessionChannelsRepo,
      sessionsRepo: deps.sessionsRepo,
      concordiaUrl: deps.concordiaUrl,
      log,
      // 単発絵文字 (🙏 / 🫡 等) をリアクションワークフローに流すための解決系。
      chatRepo: deps.chatRepo,
      messageMap,
      workflow: reactionWorkflow,
      resolveReactionMappings: deps.resolveReactionMappings,
    }, msg).catch((e) => {
      log.warn(`ingress handler failed channel=${msg.channelId}: ${(e as Error).message}`);
    });
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReactionAdd(
      { reactionsRepo, messageMap, log, workflow: reactionWorkflow, sessionChannels: sessionChannelsRepo, sessions: deps.sessionsRepo },
      reaction,
      user,
    ).catch((e) => {
      log.warn(`reaction add handler failed: ${(e as Error).message}`);
    });
  });
  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void handleReactionRemove({ reactionsRepo, messageMap, log }, reaction, user).catch((e) => {
      log.warn(`reaction remove handler failed: ${(e as Error).message}`);
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void dispatchInteraction(interaction, {
      concordiaUrl: deps.concordiaUrl,
      sessionChannelsRepo,
      pendingQuestionsRepo,
    }).catch((e) => {
      log.warn(`interaction handler failed id=${interaction.id}: ${(e as Error).message}`);
    });
  });

  client.on(Events.Error, (e) => log.error(`client error: ${e.message}`));
  client.on(Events.Warn, (m) => log.warn(`client warn: ${m}`));

  function routeEvent(ev: ConcordiaEvent, guild: import("discord.js").Guild): void {
    // error.reported は errors チャンネルへ (webhooks/layout 完備前でも poster があれば処理).
    if (ev.type === "error.reported") {
      errorPoster?.enqueue({ source: ev.source, message: ev.message, detail: ev.detail, ts: ev.ts });
      return;
    }
    if (!layout || !webhooks) return;

    if (ev.type === "session.started") {
      const meta = readMeta(deps.sessionsRepo.findSession(ev.session_id)?.metadata);
      const persona = meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
      void onSessionRegistered(
        { guild, layout, repo: sessionChannelsRepo, log, webhooks },
        {
          sessionId: ev.session_id,
          agentType: ev.provider ?? null,
          roleLabel: meta.role_label ?? null,
          personaDisplayName: persona?.display_name ?? null,
        },
      );
      void upsertSessionStatusCard({
        guild,
        layout,
        configRepo,
        sessionChannelsRepo,
        sessionsRepo: deps.sessionsRepo,
        sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
        tasksRepo: deps.tasksRepo,
        personasRepo: deps.personasRepo,
        log,
      }, ev.session_id, { allowCreate: true }); // spawn 時のみ状態チャンネルを作成
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
    if (ev.type === "chat.posted" || ev.type === "transcript.frame") {
      handleEgressEvent({
        guild,
        layout,
        webhooks,
        chatRepo: deps.chatRepo,
        sessionsRepo: deps.sessionsRepo,
        personasRepo: deps.personasRepo,
        sessionChannelsRepo,
        messageMap,
        log,
      }, ev);
      // transcript が動いている = セッションは作業中。進捗ごとに「作業中」を消して
      // 落ち着いたら最下部へ出し直す（idle で除去）。session に紐づくものだけ。
      const progressSession =
        ev.type === "transcript.frame" ? ev.target_session_id : ev.session_id ?? null;
      if (progressSession) {
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
              if (!channel || channel.type !== ChannelType.GuildText) return;
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
      workingIndicator?.noteProgress(ev.session_id);
      channelWorkState?.noteProgress(ev.session_id);
      const s = deps.sessionsRepo.findSession(ev.session_id);
      if (!s || s.provider !== "codex-cli") return;
      const row = sessionChannelsRepo.findBySessionId(ev.session_id);
      if (!row || row.status !== "active") return;
      const latest = deps.sessionsRepo.recentEvents(ev.session_id, 1)[0];
      let text = "";
      let source = "";
      try {
        const payload = latest ? JSON.parse(latest.payload) as { summary?: unknown; source?: unknown } : {};
        if (typeof payload.summary === "string") text = payload.summary.trim();
        if (typeof payload.source === "string") source = payload.source;
      } catch {}
      if (!text) return;
      // Discord session channel からの inject は元メッセージがすでに表示済み。
      // ここで再 relay すると Codex だけ二重投稿になりやすいため除外する。
      if (source.startsWith("discord:") || source === "discord-enter" || source === "discord-enter-fallback") {
        // codex: prompt が受理された = transcript が動いた。 保留中の ✅ を 1 回だけ付ける
        // (takeInjectAck は delete-on-read なので transcript.frame 経路と二重にならない)。
        const ack = takeInjectAck(ev.session_id);
        if (ack) {
          void (async () => {
            try {
              const channel = guild.channels.cache.get(ack.channelId);
              if (!channel || channel.type !== ChannelType.GuildText) return;
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
      })();
      return;
    }
    if (ev.type === "session.event" && ev.kind === "title_renamed") {
      const s = deps.sessionsRepo.findSession(ev.session_id);
      const latest = deps.sessionsRepo.recentEvents(ev.session_id, 1)[0];
      let title = "";
      try {
        const payload = latest ? JSON.parse(latest.payload) as { text?: unknown } : {};
        if (typeof payload.text === "string") title = payload.text;
      } catch {}
      if (s && title) {
        // 会話チャンネル名のリネームのみ。 状態カードの更新は 10 分毎 tick に集約。
        void onSessionTitleChanged(
          { guild, layout, repo: sessionChannelsRepo, log },
          { sessionId: ev.session_id, title, agentType: s.provider },
        );
      }
      return;
    }
    // task_update での状態カード即時更新は撤去 (更新は 10 分毎の定期 tick のみ)。
    if (ev.type === "question.posted") {
      void postQuestion({ guild, sessionChannelsRepo, pendingQuestionsRepo, log }, ev);
      return;
    }
    if (ev.type === "question.resolved") {
      // picker がローカル回答で解決 → 投稿済み質問のボタンを外す（再クリック防止）。
      void resolveQuestionMessage({ guild, sessionChannelsRepo, pendingQuestionsRepo, log }, ev);
      return;
    }
    if (ev.type === "session.inject") {
      // 環境同期: 相手プラットフォーム(Slack)由来の inject を Discord の session channel
      // にも発言者付きで転記する。Discord 由来は元発言が既に表示済なので転記しない。
      // 制御 inject (/enter 等、source 例 "discord-enter") は ^slack: に一致せず除外。
      const src = ev.source ?? "";
      if (!src.startsWith("slack:")) return;
      const sessionRow = sessionChannelsRepo.findBySessionId(ev.target_session_id);
      if (!sessionRow || sessionRow.status !== "active") return;
      const who = ev.author_label?.trim() || "Slack user";
      void (async () => {
        const client = await webhooks.getForSession(ev.target_session_id);
        if (!client) return;
        await webhooks.send(client, { content: ev.text.slice(0, 1900), username: `🔁 Slack / ${who}` });
      })();
    }
  }

  await client.login(env.token);

  return {
    async stop() {
      unsubscribe?.();
      if (costTimer) clearInterval(costTimer);
      if (monitorTimer) clearInterval(monitorTimer);
      if (prQueueTimer) clearInterval(prQueueTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (staleChannelTimer) clearInterval(staleChannelTimer);
      errorMonitor?.stop();
      if (errorPoster) { try { await errorPoster.stop(); } catch {} }
      try { await client.destroy(); } catch {}
    },
  };
}

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string }; } catch { return {}; }
}
