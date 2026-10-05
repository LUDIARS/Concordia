/**
 * 拠点側: 本社から届いた spawn / ingress を処理し、セッションの発言を本社スレッドへ返す
 * (連合 Phase 4: 本社からのセッション起動)。
 *
 * 拠点は Discord の Bot トークンを持たない。投稿はすべて連合リンクの egress 要求で
 * 本社に代行させ、本社は「その拠点に渡したスレッド」宛てだけを通す (runtime.ts)。
 *
 * @implements spec/feature/federation-link.md §本社からのセッション起動
 */
import { parseSiteEventPayload, type RemoteIngressPayload, type RemoteSpawnPayload } from "./remote-session-payload.js";
import type { RemoteThreadRegistry } from "./remote-thread-registry.js";

/** egress 本文の 1 通あたりの文字数 (Discord 2000 と protocol の 8000 に余白を残す)。 */
export const REMOTE_RELAY_CHUNK = 1800;

export interface RemoteSessionSiteDeps {
  registry: RemoteThreadRegistry;
  /** forum 起動と同じ依頼文を組み立てる (discord/ を import しないため注入)。 */
  buildPrompt(title: string, body: string, runtimeRules: readonly string[]): string;
  spawn(input: { guildId: string; channelId: string; authorId: string | null; prompt: string }): Promise<{ ok: boolean; error?: string }>;
  /** そのスレッドから起動した稼働中セッション。無ければ null。 */
  findSessionByChannel(channelId: string): string | null;
  /** セッション metadata の起動元スレッド。無ければ null。 */
  channelOfSession(sessionId: string): string | null;
  inject(input: { sessionId: string; text: string; source: string }): void;
  requestEgress(input: { guildId: string; channelId: string; text: string }): Promise<{ ok: boolean; error?: string }>;
  log: { info(message: string): void; warn(message: string): void };
}

export interface RemoteSessionSite {
  handleEvent(payload: unknown): Promise<void>;
  /** canonical session.message (AI 発言) を本社スレッドへ返す。 */
  relaySessionMessage(input: { sessionId: string; authorType: string; content: string }): Promise<void>;
}

export function splitForRelay(text: string, size = REMOTE_RELAY_CHUNK): string[] {
  const chars = Array.from(text.trim());
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(""));
  return chunks;
}

export function createRemoteSessionSite(deps: RemoteSessionSiteDeps): RemoteSessionSite {
  const notify = async (guildId: string, channelId: string, text: string): Promise<void> => {
    const result = await deps.requestEgress({ guildId, channelId, text }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (!result.ok) deps.log.warn(`remote session egress failed channel=${channelId}: ${result.error ?? "unknown"}`);
  };

  const spawn = async (payload: RemoteSpawnPayload): Promise<void> => {
    // 再接続直後の再送では起動し直さない (at-least-once)。
    if (!deps.registry.record(payload.channel_id, { guildId: payload.guild_id, siteId: null, at: payload.ts * 1000 })) {
      deps.log.info(`remote spawn duplicate ignored channel=${payload.channel_id}`);
      return;
    }
    const result = await deps.spawn({
      guildId: payload.guild_id,
      channelId: payload.channel_id,
      authorId: payload.author_id,
      prompt: deps.buildPrompt(payload.title, payload.body, payload.runtime_rules),
    }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (!result.ok) {
      deps.log.warn(`remote spawn failed channel=${payload.channel_id}: ${result.error ?? "unknown"}`);
      await notify(payload.guild_id, payload.channel_id, "拠点でのセッション起動に失敗しました。拠点の Cc のログを確認してください。");
      return;
    }
    await notify(payload.guild_id, payload.channel_id, "拠点でセッションを起動しました。このスレッドへの返信はそのセッションに届きます。");
  };

  const ingress = async (payload: RemoteIngressPayload): Promise<void> => {
    if (!deps.registry.find(payload.channel_id)) return; // この拠点で起動したスレッドだけを扱う。
    // forum の最初の投稿 (message id == thread id) は spawn 側が本文として渡している。
    if (payload.message_id === payload.channel_id) return;
    const sessionId = deps.findSessionByChannel(payload.channel_id);
    if (!sessionId) {
      await notify(payload.guild_id, payload.channel_id, "拠点のセッションがまだ準備中か、終了しています。少し待ってから送り直してください。");
      return;
    }
    deps.inject({ sessionId, text: payload.text, source: `discord:${payload.author_id}:${payload.message_id}` });
  };

  return {
    async handleEvent(raw) {
      const payload = parseSiteEventPayload(raw);
      if (!payload) return;
      if (payload.type === "spawn") await spawn(payload);
      else await ingress(payload);
    },
    async relaySessionMessage(message) {
      if (message.authorType !== "assistant") return;
      const channelId = deps.channelOfSession(message.sessionId);
      const entry = channelId ? deps.registry.find(channelId) : null;
      if (!channelId || !entry) return;
      for (const chunk of splitForRelay(message.content)) await notify(entry.guildId, channelId, chunk);
    },
  };
}
