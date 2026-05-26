// Discord bot のメインライフサイクル. spec/discord-ui.md
//
// 起動: `await startDiscordBot(deps)` で client を立ち上げ、 ready 後に
// layout (category + meta channel) を ensure、 eventBus subscribe を張る.
// 停止: 返り値の `stop()` で client を destroy + subscribe 解除.

import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Database } from "better-sqlite3";
import type { ChatRepo } from "../db/chat-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import {
  makeChatMessageReactionsRepo,
  makeDiscordConfigRepo,
  makeDiscordMessageMapRepo,
  makeDiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import { ensureDiscordLayout, type DiscordConfigSnapshot } from "./config.js";
import { handleEvent as handleEgressEvent } from "./egress.js";
import { handleMessage as handleIngressMessage } from "./ingress.js";
import { handleReactionAdd, handleReactionRemove } from "./reactions.js";
import {
  onSessionRegistered,
  onSessionStatusChanged,
} from "./session-channel.js";
import { WebhookPool } from "./webhook-pool.js";
import { readDiscordEnv } from "./types.js";

const log = {
  info: (m: string) => console.log(`[discord] ${m}`),
  warn: (m: string) => console.warn(`[discord] ${m}`),
  error: (m: string) => console.error(`[discord] ${m}`),
};

export interface DiscordBotDeps {
  db: Database;
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  personasRepo: PersonasRepo;
  isChatMuted: () => boolean;
  /** Concordia の loopback URL (POST /v1/chat を ingress が叩く). */
  concordiaUrl: string;
}

export interface DiscordBotHandle {
  stop(): Promise<void>;
}

export async function startDiscordBot(deps: DiscordBotDeps): Promise<DiscordBotHandle | null> {
  const env = readDiscordEnv();
  if (!env.enabled) {
    log.info("CONCORDIA_DISCORD_ENABLED != 1 — skip");
    return null;
  }
  if (!env.token || !env.guildId) {
    log.warn("CONCORDIA_DISCORD_TOKEN / CONCORDIA_DISCORD_GUILD_ID missing — skip");
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

  let layout: DiscordConfigSnapshot | null = null;
  let webhooks: WebhookPool | null = null;
  let unsubscribe: (() => void) | null = null;

  client.once(Events.ClientReady, async (c) => {
    log.info(`logged in as ${c.user.tag}`);
    try {
      const guild = await c.guilds.fetch(env.guildId!);
      await guild.channels.fetch();   // populate cache
      layout = await ensureDiscordLayout(guild, configRepo);
      webhooks = new WebhookPool(guild, sessionChannelsRepo);
      log.info(`layout ready: meta=${layout.metaCategoryId} sessions=${layout.sessionsCategoryId} archive=${layout.archiveCategoryId}`);

      // eventBus subscribe — egress + session-channel ハンドラを束ねる
      unsubscribe = eventBus.subscribe((ev) => routeEvent(ev, guild));
      log.info("eventBus subscribed");
    } catch (e) {
      log.error(`ready handler failed: ${(e as Error).message}`);
    }
  });

  client.on(Events.MessageCreate, (msg) => {
    void handleIngressMessage(
      { configRepo, sessionChannelsRepo, concordiaUrl: deps.concordiaUrl, log },
      msg,
    );
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReactionAdd({ reactionsRepo, messageMap, log }, reaction, user);
  });
  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void handleReactionRemove({ reactionsRepo, messageMap, log }, reaction, user);
  });

  client.on(Events.Error, (e) => log.error(`client error: ${e.message}`));
  client.on(Events.Warn, (m) => log.warn(`client warn: ${m}`));

  function routeEvent(ev: ConcordiaEvent, guild: import("discord.js").Guild): void {
    if (!layout || !webhooks) return;

    // session lifecycle
    if (ev.type === "session.started") {
      const meta = readMeta(deps.sessionsRepo.findSession(ev.session_id)?.metadata);
      const persona = meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
      void onSessionRegistered(
        { guild, layout, repo: sessionChannelsRepo, log },
        {
          sessionId: ev.session_id,
          roleLabel: meta.role_label ?? null,
          personaDisplayName: persona?.display_name ?? null,
        },
      );
      return;
    }
    if (ev.type === "session.lost") {
      void onSessionStatusChanged(
        { guild, layout, repo: sessionChannelsRepo, log },
        { sessionId: ev.session_id, status: "lost" },
      );
      return;
    }
    if (ev.type === "session.ended") {
      void onSessionStatusChanged(
        { guild, layout, repo: sessionChannelsRepo, log },
        { sessionId: ev.session_id, status: "ended" },
      );
      return;
    }

    // chat / transcript egress
    if (ev.type === "chat.posted" || ev.type === "transcript.frame") {
      handleEgressEvent(
        {
          guild,
          layout,
          webhooks,
          chatRepo: deps.chatRepo,
          sessionsRepo: deps.sessionsRepo,
          personasRepo: deps.personasRepo,
          sessionChannelsRepo,
          messageMap,
          isChatMuted: deps.isChatMuted,
          log,
        },
        ev,
      );
    }
  }

  await client.login(env.token);

  return {
    async stop() {
      unsubscribe?.();
      try { await client.destroy(); } catch { /* ignore */ }
    },
  };
}

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string }; } catch { return {}; }
}
