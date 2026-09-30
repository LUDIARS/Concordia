/**
 * 報告用のプライベートチャンネル (private_channels) の repository。 保存と照会だけを持つ
 * (spec/feature/private-channels.md §5)。 受付の判断は src/platform/private-channel-request.ts、
 * Discord での作成は src/discord/private-channel-provisioner.ts。
 *
 * @implements SPEC-PRIVCH-API
 * @implements SPEC-PRIVCH-PROVISION
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type PrivateChannelStatus = "pending" | "ready" | "failed";

export interface PrivateChannelRow {
  id: string;
  request_key: string | null;
  name: string;
  viewer_user_ids: string;
  initial_text: string | null;
  initial_message_id: string | null;
  guild_id: string | null;
  channel_id: string | null;
  status: PrivateChannelStatus;
  error: string | null;
  created_by_session_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface PrivateChannelCreateInput {
  request_key: string | null;
  name: string;
  viewer_user_ids: readonly string[];
  initial_text: string | null;
  created_by_session_id: string | null;
}

export class PrivateChannelsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: PrivateChannelCreateInput, now: number = Date.now()): PrivateChannelRow {
    const id = `prc_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO private_channels(id, request_key, name, viewer_user_ids, initial_text, initial_message_id, guild_id,
        channel_id, status, error, created_by_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', NULL, ?, ?, ?)
    `).run(
      id, input.request_key, input.name, JSON.stringify([...input.viewer_user_ids]), input.initial_text,
      input.created_by_session_id, now, now,
    );
    return this.find(id)!;
  }

  find(id: string): PrivateChannelRow | null {
    return (this.db.prepare("SELECT * FROM private_channels WHERE id = ?").get(id) as PrivateChannelRow | undefined) ?? null;
  }

  findByKey(key: string): PrivateChannelRow | null {
    return (this.db.prepare("SELECT * FROM private_channels WHERE request_key = ?").get(key) as PrivateChannelRow | undefined)
      ?? null;
  }

  /** egress の送信先判定 (CC-PRIVCH-INV-03)。 ready のチャンネルだけ。 */
  isReadyChannel(channelId: string): boolean {
    return this.db.prepare("SELECT 1 FROM private_channels WHERE channel_id = ? AND status = 'ready'").get(channelId) !== undefined;
  }

  listPending(): PrivateChannelRow[] {
    return this.db.prepare("SELECT * FROM private_channels WHERE status = 'pending' ORDER BY created_at, id").all() as PrivateChannelRow[];
  }

  /** 作成できたチャンネルを記録する (以後は作り直さない)。 */
  recordChannel(id: string, input: { guild_id: string; channel_id: string }, now: number = Date.now()): void {
    this.db.prepare("UPDATE private_channels SET guild_id = ?, channel_id = ?, updated_at = ? WHERE id = ?")
      .run(input.guild_id, input.channel_id, now, id);
  }

  recordInitialMessage(id: string, messageId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE private_channels SET initial_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now, id);
  }

  markReady(id: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE private_channels SET status = 'ready', error = NULL, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, id);
  }

  markFailed(id: string, error: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE private_channels SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(error, now, id);
  }
}

export function viewerIdsOf(row: Pick<PrivateChannelRow, "viewer_user_ids">): string[] {
  try {
    const parsed: unknown = JSON.parse(row.viewer_user_ids);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // 自分で書いた JSON なので壊れていることは想定しない。 閲覧者なしとして扱い、 作成側で failed にする。
    return [];
  }
}
