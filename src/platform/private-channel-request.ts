/**
 * 報告用プライベートチャンネルの受付 (spec/feature/private-channels.md §2)。
 *
 * 名前の正規化・閲覧者の決定・冪等判定を行い、 新規なら pending で記録して作成を Bot へ依頼する。
 * Discord での作成は Bot 側 (private-channel-provisioner.ts) で、 ここは Discord に触れない。
 *
 * @implements SPEC-PRIVCH-API
 */

import type { PrivateChannelRow, PrivateChannelsRepo } from "../db/private-channels-repo.js";

/** Discord のチャンネル名上限。 */
const MAX_CHANNEL_NAME = 100;
/** Discord の 1 投稿の上限。 */
export const MAX_PRIVATE_CHANNEL_TEXT = 2_000;
const DISCORD_USER_ID = /^\d{17,20}$/;

export type PrivateChannelRequestError = "invalid_name" | "invalid_viewer_user_ids" | "no_viewers" | "invalid_text" | "invalid_key";

export interface PrivateChannelRequestInput {
  name: unknown;
  viewer_user_ids?: unknown;
  text?: unknown;
  key?: unknown;
  session_id?: unknown;
}

export interface PrivateChannelRequestPorts {
  repo: Pick<PrivateChannelsRepo, "create" | "findByKey">;
  /** 閲覧者を省略したときの既定 (設定の mention user)。 */
  adminUserId(): string | null;
  /** 新規に受け付けたレコードの作成を Bot へ依頼する。 */
  requestProvision(row: PrivateChannelRow): void;
  now?: () => number;
}

export type PrivateChannelRequestResult =
  | { ok: true; row: PrivateChannelRow; created: boolean }
  | { ok: false; error: PrivateChannelRequestError };

export function requestPrivateChannel(
  ports: PrivateChannelRequestPorts,
  input: PrivateChannelRequestInput,
): PrivateChannelRequestResult {
  const key = input.key === undefined || input.key === null ? null : typeof input.key === "string" ? input.key.trim() : undefined;
  if (key === undefined || (key !== null && (key.length === 0 || key.length > 200))) return { ok: false, error: "invalid_key" };
  // 同じ key は同じレコード (CC-PRIVCH-INV-02)。 内容の検証より先に返し、 再送で失敗させない。
  const existing = key ? ports.repo.findByKey(key) : null;
  if (existing) return { ok: true, row: existing, created: false };

  const name = typeof input.name === "string" ? normalizePrivateChannelName(input.name) : "";
  if (!name) return { ok: false, error: "invalid_name" };
  const viewers = resolveViewers(input.viewer_user_ids, ports.adminUserId());
  if (!viewers.ok) return viewers;
  const text = input.text === undefined || input.text === null ? null : typeof input.text === "string" ? input.text.trim() : undefined;
  if (text === undefined || (text !== null && text.length > MAX_PRIVATE_CHANNEL_TEXT)) return { ok: false, error: "invalid_text" };
  const sessionId = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id.trim().slice(0, 200) : null;

  const row = ports.repo.create({
    request_key: key,
    name,
    viewer_user_ids: viewers.ids,
    initial_text: text || null,
    created_by_session_id: sessionId,
  }, ports.now?.() ?? Date.now());
  ports.requestProvision(row);
  return { ok: true, row, created: true };
}

function resolveViewers(value: unknown, adminUserId: string | null):
  | { ok: true; ids: string[] }
  | { ok: false; error: PrivateChannelRequestError } {
  if (value === undefined || value === null) {
    const admin = adminUserId?.trim();
    return admin && DISCORD_USER_ID.test(admin) ? { ok: true, ids: [admin] } : { ok: false, error: "no_viewers" };
  }
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && DISCORD_USER_ID.test(id))) {
    return { ok: false, error: "invalid_viewer_user_ids" };
  }
  const ids = [...new Set(value as string[])];
  return ids.length > 0 ? { ok: true, ids } : { ok: false, error: "no_viewers" };
}

/**
 * Discord のチャンネル名規則へ正規化する: 小文字化、 空白 → `-`、 英数字・`-`・`_`・非 ASCII 以外を除去、
 * 連続 `-` の圧縮、 前後の `-` 除去、 100 文字まで。 空になれば空文字 (呼び出し側が拒否する)。
 */
export function normalizePrivateChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9_\-\u{80}-\u{10FFFF}]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHANNEL_NAME);
}

/** 公開用の表現 (GET / POST の応答)。 url は ready のときだけ。 */
export function privateChannelView(row: PrivateChannelRow): {
  id: string;
  status: PrivateChannelRow["status"];
  channel_id: string | null;
  url: string | null;
  error: string | null;
} {
  return {
    id: row.id,
    status: row.status,
    channel_id: row.channel_id,
    url: row.status === "ready" && row.guild_id && row.channel_id
      ? `https://discord.com/channels/${row.guild_id}/${row.channel_id}`
      : null,
    error: row.error,
  };
}
