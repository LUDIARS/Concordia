export interface SlackChannelMessage {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

export type SlackChannelMessageRoute =
  | { kind: "session"; sessionId: string; channelId: string }
  | { kind: "hub"; channelId: string }
  | { kind: "ignore"; reason: "invalid" | "bot" | "subtype" | "thread_reply" | "unknown_channel" | "session_inactive" };

export function routeSlackChannelMessage(input: {
  event: SlackChannelMessage;
  hubChannelId: string;
  botUserId: string | null;
  sessionForChannel: (channelId: string) => string | null;
  /**
   * session の現在の状態 (active かどうか) を確認する。 未指定なら従来どおり状態を
   * 確認せずルーティングする (呼び出し側が未対応のときの後方互換)。 終了済み
   * session のチャンネルへの投稿を inject 扱いにしてしまう事故を防ぐため、
   * bot.ts からは deps.readModel.isSessionActive を渡す。
   */
  isSessionActive?: (sessionId: string) => boolean;
}): SlackChannelMessageRoute {
  const { event } = input;
  if (event.type !== "message" || !event.channel) return { kind: "ignore", reason: "invalid" };
  if (event.subtype) return { kind: "ignore", reason: "subtype" };
  if (event.bot_id || (input.botUserId && event.user === input.botUserId)) return { kind: "ignore", reason: "bot" };
  if (event.thread_ts) return { kind: "ignore", reason: "thread_reply" };
  const sessionId = input.sessionForChannel(event.channel);
  if (sessionId) {
    // 終了済み (archive 待ち等でチャンネルがまだ残っている) session への投稿は
    // inject 扱いにしない。 session 状態を検査せず素通しすると、 もう応答しない
    // session へメッセージが静かに消える / 誤配信されるため (継続レビュー指摘)。
    if (input.isSessionActive && !input.isSessionActive(sessionId)) {
      return { kind: "ignore", reason: "session_inactive" };
    }
    return { kind: "session", sessionId, channelId: event.channel };
  }
  if (event.channel === input.hubChannelId) return { kind: "hub", channelId: event.channel };
  return { kind: "ignore", reason: "unknown_channel" };
}
