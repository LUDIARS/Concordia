// Slack platform 共通型 + env パース。@slack/* への依存を最小化するための
// インジェクション境界（discord/types.ts と対になる構成）。

import { readJsonObject } from "../shared/json-object.js";

export interface SlackEnv {
  enabled: boolean;
  /** xoxb- bot token（Web API 呼び出し用）。 */
  botToken: string | null;
  /** xapp- app-level token（Socket Mode 接続用）。 */
  appToken: string | null;
  /** Hub channel ID。session 非紐付け chat、slash、Cost/Sessions Canvas の配置先。 */
  channelId: string | null;
  /** session.ended から public channel を archive するまでの猶予。 */
  archiveDelayMin: number;
  /** env 値が無効で既定値へ戻ったことを起動時ログへ出すための marker。 */
  archiveDelayInvalid: boolean;
}

export const DEFAULT_SLACK_ARCHIVE_DELAY_MIN = 30;

export function readSlackEnv(env: NodeJS.ProcessEnv = process.env): SlackEnv {
  const archive = parseSlackArchiveDelayMin(env.CONCORDIA_SLACK_ARCHIVE_DELAY_MIN);
  return {
    enabled: String(env.CONCORDIA_SLACK_ENABLED ?? "").trim() === "1",
    botToken: env.CONCORDIA_SLACK_BOT_TOKEN?.trim() || null,
    appToken: env.CONCORDIA_SLACK_APP_TOKEN?.trim() || null,
    channelId: env.CONCORDIA_SLACK_CHANNEL_ID?.trim() || null,
    archiveDelayMin: archive.value,
    archiveDelayInvalid: archive.invalid,
  };
}

export function parseSlackArchiveDelayMin(raw: string | undefined): { value: number; invalid: boolean } {
  if (raw === undefined || raw.trim() === "") {
    return { value: DEFAULT_SLACK_ARCHIVE_DELAY_MIN, invalid: false };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { value: DEFAULT_SLACK_ARCHIVE_DELAY_MIN, invalid: true };
  }
  return { value, invalid: false };
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
