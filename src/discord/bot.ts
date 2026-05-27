import { ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Database } from "better-sqlite3";
import type { ChatRepo } from "../db/chat-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
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
import { handleEvent as handleEgressEvent } from "./egress.js";
import { handleMessage as handleIngressMessage } from "./ingress.js";
import { handleReactionAdd, handleReactionRemove } from "./reactions.js";
import { onSessionRegistered, onSessionStatusChanged, onSessionTitleChanged } from "./session-channel.js";
import { upsertSessionStatusCard } from "./session-status-card.js";
import { upsertCostChannelMessage } from "./cost-channel.js";
import { WebhookPool } from "./webhook-pool.js";
import { readDiscordEnv } from "./types.js";
import { dispatchInteraction, registerGuildCommands } from "./commands.js";
import { postQuestion } from "./question.js";
import { createChildLogger } from "../shared/logger.js";

// pino 経由で logs/concordia.log にも残る. egress / session-channel に渡す
// deps.log もこの object 経由になるので、 過剰ログを仕込んだ場所の出力が
// 一律にファイルに記録される.
const discordLog = createChildLogger("discord");
const log = {
  info: (m: string) => discordLog.info(m),
  warn: (m: string) => discordLog.warn(m),
  error: (m: string) => discordLog.error(m),
};

export interface DiscordBotDeps {
  db: Database;
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  sessionTaskRecordsRepo: SessionTaskRecordsRepo;
  personasRepo: PersonasRepo;
  concordiaUrl: string;
}

export interface DiscordBotHandle {
  stop(): Promise<void>;
}

export async function startDiscordBot(deps: DiscordBotDeps): Promise<DiscordBotHandle | null> {
  const env = readDiscordEnv();
  if (!env.enabled) {
    log.info("CONCORDIA_DISCORD_ENABLED != 1; skip");
    return null;
  }
  if (!env.token || !env.guildId) {
    log.warn("CONCORDIA_DISCORD_TOKEN / CONCORDIA_DISCORD_GUILD_ID missing; skip");
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

  let layout: DiscordConfigSnapshot | null = null;
  let webhooks: WebhookPool | null = null;
  let unsubscribe: (() => void) | null = null;
  let costTimer: ReturnType<typeof setInterval> | null = null;
  const relayTranscript = process.env.CONCORDIA_DISCORD_RELAY_TRANSCRIPT === "1";
  const promptRelayLast = new Map<string, { text: string; at: number }>();

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
      if (!relayTranscript) {
        log.info("discord transcript relay disabled (set CONCORDIA_DISCORD_RELAY_TRANSCRIPT=1 to enable)");
      }
      const costCh = guild.channels.cache.get(layout.costChannelId);
      if (costCh && costCh.type === ChannelType.GuildText) {
        const refresh = () =>
          upsertCostChannelMessage(
            costCh,
            deps.sessionsRepo,
            (k) => configRepo.get(k),
            (k, v) => configRepo.set(k, v),
          ).catch((e) => log.warn(`cost channel update failed: ${(e as Error).message}`));
        void refresh();
        const mins = Math.max(10, Number(process.env.CONCORDIA_DISCORD_COST_REFRESH_MIN ?? "10") || 10);
        costTimer = setInterval(() => { void refresh(); }, mins * 60 * 1000);
        costTimer.unref?.();
      } else {
        log.warn(`cost channel unavailable id=${layout.costChannelId}`);
      }
      for (const row of sessionChannelsRepo.listActive()) {
        void upsertSessionStatusCard({
          guild,
          layout,
          configRepo,
          sessionChannelsRepo,
          sessionsRepo: deps.sessionsRepo,
          sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
          personasRepo: deps.personasRepo,
          log,
        }, row.session_id);
      }
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
    }, msg).catch((e) => {
      log.warn(`ingress handler failed channel=${msg.channelId}: ${(e as Error).message}`);
    });
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReactionAdd({ reactionsRepo, messageMap, log }, reaction, user).catch((e) => {
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
    if (!layout || !webhooks) return;

    if (ev.type === "session.started") {
      const meta = readMeta(deps.sessionsRepo.findSession(ev.session_id)?.metadata);
      const persona = meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
      void onSessionRegistered(
        { guild, layout, repo: sessionChannelsRepo, log },
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
        personasRepo: deps.personasRepo,
        log,
      }, ev.session_id);
      return;
    }
    if (ev.type === "session.lost") {
      void onSessionStatusChanged({ guild, layout, repo: sessionChannelsRepo, log }, { sessionId: ev.session_id, status: "lost" });
      void upsertSessionStatusCard({
        guild,
        layout,
        configRepo,
        sessionChannelsRepo,
        sessionsRepo: deps.sessionsRepo,
        sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
        personasRepo: deps.personasRepo,
        log,
      }, ev.session_id);
      return;
    }
    if (ev.type === "session.ended") {
      void onSessionStatusChanged({ guild, layout, repo: sessionChannelsRepo, log }, { sessionId: ev.session_id, status: "ended" });
      void upsertSessionStatusCard({
        guild,
        layout,
        configRepo,
        sessionChannelsRepo,
        sessionsRepo: deps.sessionsRepo,
        sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
        personasRepo: deps.personasRepo,
        log,
      }, ev.session_id);
      return;
    }
    if (ev.type === "stat.collected") {
      void upsertSessionStatusCard({
        guild,
        layout,
        configRepo,
        sessionChannelsRepo,
        sessionsRepo: deps.sessionsRepo,
        sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
        personasRepo: deps.personasRepo,
        log,
      }, ev.session_id);
      return;
    }
    if (ev.type === "chat.posted" || (relayTranscript && ev.type === "transcript.frame")) {
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
      return;
    }
    if (ev.type === "session.event" && ev.kind === "prompt") {
      const s = deps.sessionsRepo.findSession(ev.session_id);
      if (!s || s.provider !== "codex-cli") return;
      const row = sessionChannelsRepo.findBySessionId(ev.session_id);
      if (!row || row.status !== "active") return;
      const latest = deps.sessionsRepo.recentEvents(ev.session_id, 1)[0];
      let text = "";
      try {
        const payload = latest ? JSON.parse(latest.payload) as { summary?: unknown } : {};
        if (typeof payload.summary === "string") text = payload.summary.trim();
      } catch {}
      if (!text) return;
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
        void onSessionTitleChanged({ guild, layout, repo: sessionChannelsRepo, log }, { sessionId: ev.session_id, title });
        void upsertSessionStatusCard({
          guild,
          layout,
          configRepo,
          sessionChannelsRepo,
          sessionsRepo: deps.sessionsRepo,
          sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
          personasRepo: deps.personasRepo,
          log,
        }, ev.session_id);
      }
      return;
    }
    if (ev.type === "session.event" && ev.kind === "task_update") {
      void upsertSessionStatusCard({
        guild,
        layout,
        configRepo,
        sessionChannelsRepo,
        sessionsRepo: deps.sessionsRepo,
        sessionTaskRecordsRepo: deps.sessionTaskRecordsRepo,
        personasRepo: deps.personasRepo,
        log,
      }, ev.session_id);
      return;
    }
    if (ev.type === "question.posted") {
      void postQuestion({ guild, sessionChannelsRepo, pendingQuestionsRepo, log }, ev);
    }
  }

  await client.login(env.token);

  return {
    async stop() {
      unsubscribe?.();
      if (costTimer) clearInterval(costTimer);
      try { await client.destroy(); } catch {}
    },
  };
}

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string }; } catch { return {}; }
}
