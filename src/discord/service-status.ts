import type { TextChannel } from "discord.js";
import { DiscordAPIError } from "discord.js";
import type { Database } from "better-sqlite3";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { serviceStatusClient } from "../service-status/client.js";
import { projectStatus, statusServiceKey, type StatusSnapshot } from "../service-status/policy.js";
import { statusSettings } from "../service-status/settings.js";
import { StatusPublisher, type StatusChannelPort } from "../service-status/publisher.js";

export function statusChannelPort(channel: TextChannel): StatusChannelPort {
  return {
    async send(content, nonce) { return (await channel.send({ content, nonce, enforceNonce: true, allowedMentions: { parse: [] } })).id; },
    async edit(id, content) { await channel.messages.edit(id, { content, allowedMentions: { parse: [] } }); },
    async remove(id) {
      try { await channel.messages.delete(id); }
      catch (error) { if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error; /* already deleted */ }
    },
    async findNonce(nonce) {
      const messages = await channel.messages.fetch({ limit: 100 });
      return messages.find((message) => message.author.id === channel.client.user?.id && message.nonce === nonce)?.id ?? null;
    },
  };
}

/** @implements CC-SS-01 CC-SS-03 CC-SS-06 — one logical runtime owns one scoped publisher. */
export function startServiceStatusDiscord(deps: {
  db: Database; subsidiaryId: string | null; config: DiscordConfigRepo; channel: TextChannel;
  warn: (message: string) => void; read?: () => Promise<StatusSnapshot>;
}) {
  let stopped = false;
  let current: Promise<void> | null = null;
  const publisher = new StatusPublisher(deps.config, statusChannelPort(deps.channel));
  const refresh = async () => {
    if (stopped) return;
    const selection = deps.subsidiaryId ? statusSettings(deps.db, deps.subsidiaryId).get() : null;
    let snapshot: StatusSnapshot | null = null;
    try { snapshot = await (deps.read?.() ?? serviceStatusClient.get()); }
    catch { deps.warn("service status observations unavailable"); }
    if (stopped) return;
    const projection = snapshot ? projectStatus(snapshot, selection, Date.now()) : null;
    const scope = JSON.stringify({ policy: 1, selection,
      sites: projection?.sites.map((site) => `${site.id}/${site.name}`).sort() ?? null,
      visible: projection?.services.map((service) => statusServiceKey(service.siteId, service.code)).sort() ?? null });
    // An outage must not erase ownership metadata or repeatedly clear history.
    const previousScope = deps.config.get("service_status_effective_scope") ?? scope;
    const effectiveScope = snapshot ? scope : JSON.stringify({ selection, unavailable: true });
    await publisher.refresh(projection, snapshot ? scope : selection === null ? previousScope : effectiveScope, () => stopped);
    if (!stopped && snapshot) deps.config.set("service_status_effective_scope", scope);
  };
  const run = () => {
    if (current) return;
    const task = refresh()
      .catch(() => deps.warn("service status publish failed; inspect pending delivery/configuration"))
      .finally(() => { if (current === task) current = null; });
    current = task;
  };
  const timer = setInterval(run, 60_000); timer.unref?.(); run();
  return { async stop() { stopped = true; clearInterval(timer); await current; } };
}
