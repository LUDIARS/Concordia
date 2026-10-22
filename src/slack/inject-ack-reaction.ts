/**
 * Slack の指示 (session channel への投稿 → inject) に受領リアクション ✅ を付ける。
 *
 * Discord ingress と同じ契約: inject が届いただけでは付けず、 そのセッションの
 * session.message / prompt が動いた最初のタイミングで 1 回だけ付ける
 * (platform/inject-ack-tracker.ts)。 付与は best-effort で、 失敗はログだけ残す
 * (bot に reactions:write scope が無い場合など)。
 */
import { createInjectAckTracker } from "../platform/inject-ack-tracker.js";

/** Slack の絵文字名 (reactions.add の name)。 Discord の ✅ と同じ。 */
export const SLACK_ACCEPTED_INJECT_REACTION = "white_check_mark";

export interface SlackReactionsClient {
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
}

export interface SlackInjectAckDeps {
  web: SlackReactionsClient;
  log: { warn(message: string): void };
}

export interface SlackInjectAck {
  /** inject 成功時に投稿 (channel, ts) を保留登録する。 */
  record(sessionId: string, channelId: string, ts: string): void;
  /** セッションが動いた。 保留中の投稿があれば ✅ を付ける。 */
  onSessionProgress(sessionId: string): Promise<void>;
  clear(): void;
}

export function createSlackInjectAck(deps: SlackInjectAckDeps): SlackInjectAck {
  const tracker = createInjectAckTracker();
  return {
    record(sessionId, channelId, ts) {
      tracker.record(sessionId, channelId, ts);
    },
    async onSessionProgress(sessionId) {
      const ack = tracker.take(sessionId);
      if (!ack) return;
      try {
        await deps.web.reactions.add({ channel: ack.channelId, timestamp: ack.messageId, name: SLACK_ACCEPTED_INJECT_REACTION });
      } catch (e) {
        // 同じ投稿に既に付いている (already_reacted) のは成功扱い。
        if ((e as { data?: { error?: string } }).data?.error === "already_reacted") return;
        deps.log.warn(`inject-ack: react failed session=${sessionId} channel=${ack.channelId}: ${(e as Error).message}`);
      }
    },
    clear() {
      tracker.clear();
    },
  };
}
