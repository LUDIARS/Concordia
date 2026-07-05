// Slack platform 共通型 + env パース。@slack/* への依存を最小化するための
// インジェクション境界（discord/types.ts と対になる構成）。

import { readJsonObject } from "../shared/json-object.js";

export interface SlackEnv {
  enabled: boolean;
  /** xoxb- bot token（Web API 呼び出し用）。 */
  botToken: string | null;
  /** xapp- app-level token（Socket Mode 接続用）。 */
  appToken: string | null;
  /**
   * セッション入出力 + メタチャットを集約する単一チャンネル ID（C…）。
   * v0.1 は per-session チャンネルを作らず、この 1 チャンネル内で
   * thread-per-session 方式で多重化する（spec/feature/slack-platform.md）。
   */
  channelId: string | null;
}

export function readSlackEnv(env: NodeJS.ProcessEnv = process.env): SlackEnv {
  return {
    enabled: String(env.CONCORDIA_SLACK_ENABLED ?? "").trim() === "1",
    botToken: env.CONCORDIA_SLACK_BOT_TOKEN?.trim() || null,
    appToken: env.CONCORDIA_SLACK_APP_TOKEN?.trim() || null,
    channelId: env.CONCORDIA_SLACK_CHANNEL_ID?.trim() || null,
  };
}

/** start に必要な設定が全て揃っているか（揃わなければ bot は no-op 起動）。 */
export function slackEnvReady(env: SlackEnv): boolean {
  return env.enabled && !!env.botToken && !!env.appToken && !!env.channelId;
}

/**
 * chat_messages.metadata に Slack ingress が刻む marker の parse helper。
 * egress 側で「Slack 由来の chat を再び Slack に出す」自己ループを検知する。
 * discord/egress.ts の readChatMeta と同じ役割。
 */
export function readSlackChatMeta(s: string | null | undefined): {
  source?: string;
  slack_user_id?: string;
} {
  const meta = readJsonObject(s);
  return {
    source: typeof meta.source === "string" ? meta.source : undefined,
    slack_user_id: typeof meta.slack_user_id === "string" ? meta.slack_user_id : undefined,
  };
}
