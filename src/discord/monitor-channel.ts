import type { TextChannel } from "discord.js";
import type { MonitorSnapshot } from "../platform/chat-read-model.js";
import { renderMonitorPages } from "./monitor-render.js";
import { monitorDeliveryAction } from "./monitor-delivery-policy.js";

const MONITOR_MESSAGE_KEY = "monitor_status_message_id";
const STATE_KEY = "monitor_status_delivery_state";
const MARKER = "-# cc:session-monitor:v1";
const PAGE_COUNT_KEY = "monitor_status_page_count";
const flights = new Map<string, Promise<void>>();

export interface DiscordDedupStats {
  skipped_chat_posted: number;
  skipped_transcript_frame: number;
  total: number;
}

export interface MonitorOptions {
  stats?: DiscordDedupStats;
}

export async function upsertMonitorChannelMessage(
  channel: TextChannel,
  snapshot: MonitorSnapshot,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  opts: MonitorOptions = {},
): Promise<void> {
  const pending = flights.get(channel.id);
  if (pending) return pending;
  const work = updateMonitor(channel, snapshot, configGet, configSet, opts);
  flights.set(channel.id, work);
  try { await work; } finally { if (flights.get(channel.id) === work) flights.delete(channel.id); }
}

async function updateMonitor(channel: TextChannel, snapshot: MonitorSnapshot,
  get: (k: string) => string | null, set: (k: string, v: string) => void, opts: MonitorOptions): Promise<void> {
  const pages = renderMonitorPages(snapshot, opts.stats);
  const previous = Number(get(PAGE_COUNT_KEY) ?? 1);
  if (!Number.isSafeInteger(previous) || previous < 1 || previous > 1000 || pages.length > 1000) {
    throw new Error("monitor page count requires reconciliation");
  }
  set(PAGE_COUNT_KEY, String(Math.max(previous, pages.length)));
  for (let page = 0; page < Math.max(previous, pages.length); page++) {
    await updatePage(channel, pages[page] ?? "対象セッションなし", page, get, set);
  }
}

async function updatePage(channel: TextChannel, content: string, page: number,
  get: (k: string) => string | null, set: (k: string, v: string) => void): Promise<void> {
  const suffix = page === 0 ? "" : `_${page}`;
  const messageKey = `${MONITOR_MESSAGE_KEY}${suffix}`;
  const stateKey = `${STATE_KEY}${suffix}`;
  const marker = page === 0 ? MARKER : `${MARKER}:page:${page}`;
  const body = `${content}\n${marker}`;
  const payload = { content: body, allowedMentions: { parse: [] as never[] } };
  const id = get(messageKey);
  if (id) {
    // A lookup/edit failure may be permission loss or timeout. Never recreate.
    const message = await channel.messages.fetch(id);
    if (message.author.id !== channel.client.user.id) throw new Error("monitor message owner mismatch");
    await message.edit(payload);
    return;
  }
  const recent = await channel.messages.fetch({ limit: 100 });
  const matches = [...recent.values()].filter(message => message.author.id === channel.client.user.id
    && (message.content.split("\n").includes(marker)
      || (page === 0 && !message.content.includes(MARKER) && message.content.startsWith("## Concordia Monitor\n"))));
  if (matches.length > 1) throw new Error("multiple monitor messages require reconciliation");
  const found = matches[0];
  const action = monitorDeliveryAction(get(stateKey), !!found);
  if (found) {
    set(messageKey, found.id); set(stateKey, "ready");
    await found.edit(payload);
    return;
  }
  if (action !== "create") throw new Error("monitor creation outcome unknown; reconcile Discord history before retry");
  // Persist before I/O. A send timeout leaves a durable no-resend fence.
  set(stateKey, "sending");
  const sent = await channel.send(payload);
  set(messageKey, sent.id); set(stateKey, "ready");
}
