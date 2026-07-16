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
  | { kind: "ignore"; reason: "invalid" | "bot" | "subtype" | "thread_reply" | "unknown_channel" };

export function routeSlackChannelMessage(input: {
  event: SlackChannelMessage;
  hubChannelId: string;
  botUserId: string | null;
  sessionForChannel: (channelId: string) => string | null;
}): SlackChannelMessageRoute {
  const { event } = input;
  if (event.type !== "message" || !event.channel) return { kind: "ignore", reason: "invalid" };
  if (event.subtype) return { kind: "ignore", reason: "subtype" };
  if (event.bot_id || (input.botUserId && event.user === input.botUserId)) return { kind: "ignore", reason: "bot" };
  if (event.thread_ts) return { kind: "ignore", reason: "thread_reply" };
  const sessionId = input.sessionForChannel(event.channel);
  if (sessionId) return { kind: "session", sessionId, channelId: event.channel };
  if (event.channel === input.hubChannelId) return { kind: "hub", channelId: event.channel };
  return { kind: "ignore", reason: "unknown_channel" };
}
