/**
 * 本社: 拠点から届いた egress 依頼 (拠点セッションの発言・起動結果) を Discord へ送る。
 *
 * 拠点へ渡したスレッド (`/spawn site:` の受付スレッド・forum 投稿) は thread なので、
 * webhook は thread 自身ではなく親 channel / forum に作り、 thread_id を付けて送る。
 * thread を直接 webhook pool に渡すと「channel not text」で必ず null になり、
 * 拠点の「起動しました」も発言の中継も届かなかった (2026-10-11 MELPOT)。
 *
 * @implements spec/feature/federation-link.md §本社からのセッション起動
 */
/** egress の宛先 channel のうち、 送信先の決定に使う属性だけ。 */
export interface EgressChannel {
  guildId: string;
  isThread(): boolean;
  parentId: string | null;
}

/** webhook 送信の中身。 Discord SDK の型へ依存しない (連合層は chat 層を import しない)。 */
export interface EgressSendOptions {
  content: string;
  username: string;
  allowedMentions: { parse: [] };
  threadId?: string;
}

export interface FederationEgressDeps<W> {
  guildId: string;
  fetchChannel(channelId: string): Promise<EgressChannel | null>;
  getWebhook(channelId: string): Promise<W | null>;
  send(client: W, options: EgressSendOptions): Promise<unknown>;
  log: { warn(message: string): void };
}

export interface FederationEgressRequest {
  guild_id: string;
  channel_id: string;
  text: string;
}

export type FederationEgressResult = { ok: true } | { ok: false; error: string };

/** webhook を作る channel と、 thread なら thread_id。 */
export function resolveEgressTarget(channelId: string, channel: EgressChannel): { webhookChannelId: string; threadId?: string } | null {
  if (!channel.isThread()) return { webhookChannelId: channelId };
  if (!channel.parentId) return null;
  return { webhookChannelId: channel.parentId, threadId: channelId };
}

export function createFederationEgressExecutor<W>(deps: FederationEgressDeps<W>) {
  const fail = (request: FederationEgressRequest, error: string): FederationEgressResult => {
    // 拠点へ返すだけだと本社側に痕跡が残らず、 拠点ログを見ないと原因が分からない。
    deps.log.warn(`federation egress rejected channel=${request.channel_id}: ${error}`);
    return { ok: false, error };
  };
  return async (request: FederationEgressRequest): Promise<FederationEgressResult> => {
    // guild id と実 channel 所属をここで確認する。連合層は Discord 型へ依存せず、
    // 本社の Discord ポートだけが channel → guild の対応を知る。
    if (request.guild_id !== deps.guildId) return fail(request, "destination guild is not this Discord runtime");
    const channel = await deps.fetchChannel(request.channel_id).catch(() => null);
    if (!channel || channel.guildId !== deps.guildId) return fail(request, "destination channel is not in the requested guild");
    const target = resolveEgressTarget(request.channel_id, channel);
    if (!target) return fail(request, "destination thread has no parent channel");
    const webhook = await deps.getWebhook(target.webhookChannelId);
    if (!webhook) return fail(request, "Discord webhook is unavailable for destination channel");
    const sent = await deps.send(webhook, {
      content: request.text,
      username: "Concordia",
      allowedMentions: { parse: [] },
      ...(target.threadId ? { threadId: target.threadId } : {}),
    });
    return sent ? { ok: true } : fail(request, "Discord send failed");
  };
}
