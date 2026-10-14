/**
 * バグバウンティ企画 (bounty_events) の repository。 保存・照会・早期終了の CAS だけを持つ。
 * 検証と紐付けの判断は src/bounty/event-policy.ts が持つ (spec/feature/bug-bounty.md §0 §10 §18)。
 *
 * @implements SPEC-BOUNTY-EVENT
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BountyEvent, BountyEventChannel, BountyEventFields, BountyRewardOverride } from "../bounty/event-policy.js";

interface BountyEventRow {
  id: string;
  title: string;
  starts_at: number;
  ends_at: number;
  projects_json: string;
  channels_json: string;
  guidance: string;
  reward_override_json: string | null;
  created_by: string;
  ended_early_at: number | null;
  ended_by: string | null;
  created_at: number;
  updated_at: number;
}

/** 企画と記録の項目 (作成者・時刻)。 */
export interface BountyEventRecord extends BountyEvent {
  createdBy: string;
  endedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export class BountyEventsRepo {
  constructor(private readonly db: Database.Database) {}

  create(fields: BountyEventFields, createdBy: string, now: number = Date.now()): BountyEventRecord {
    const id = `be_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO bounty_events(id, title, starts_at, ends_at, projects_json, channels_json, guidance,
        reward_override_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fields.title, fields.startsAt, fields.endsAt, JSON.stringify(fields.projects), JSON.stringify(fields.channels),
      fields.guidance, fields.rewardOverride ? JSON.stringify(fields.rewardOverride) : null, createdBy, now, now);
    return this.find(id)!;
  }

  find(id: string): BountyEventRecord | null {
    const row = this.db.prepare("SELECT * FROM bounty_events WHERE id = ?").get(id) as BountyEventRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 全件 (開始の新しい順)。 企画は少数なので段階の絞り込みは呼び出し側で行う。 */
  list(): BountyEventRecord[] {
    return (this.db.prepare("SELECT * FROM bounty_events ORDER BY starts_at DESC, id DESC").all() as BountyEventRow[])
      .map(toRecord);
  }

  /** その時刻に開催中の企画。 */
  listOpenAt(now: number): BountyEventRecord[] {
    return (this.db.prepare(`
      SELECT * FROM bounty_events
      WHERE starts_at <= ? AND ends_at > ? AND (ended_early_at IS NULL OR ended_early_at > ?)
      ORDER BY ends_at, starts_at, id
    `).all(now, now, now) as BountyEventRow[]).map(toRecord);
  }

  /** 編集。 検証済みの値をまとめて書く。 `expectUpdatedAt` が違えば (他の編集が先に入った) 書かず false。 */
  update(id: string, fields: BountyEventFields, expectUpdatedAt: number, now: number = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE bounty_events SET title = ?, starts_at = ?, ends_at = ?, projects_json = ?, channels_json = ?, guidance = ?,
        reward_override_json = ?, updated_at = ?
      WHERE id = ? AND updated_at = ? AND ended_early_at IS NULL
    `).run(fields.title, fields.startsAt, fields.endsAt, JSON.stringify(fields.projects), JSON.stringify(fields.channels),
      fields.guidance, fields.rewardOverride ? JSON.stringify(fields.rewardOverride) : null, now, id, expectUpdatedAt).changes > 0;
  }

  /** 早期終了。 まだ早期終了しておらず、 終了時刻前のときだけ書く。 */
  endEarly(id: string, endedBy: string, now: number = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE bounty_events SET ended_early_at = ?, ended_by = ?, updated_at = ?
      WHERE id = ? AND ended_early_at IS NULL AND ends_at > ?
    `).run(now, endedBy, now, id, now).changes > 0;
  }
}

function toRecord(row: BountyEventRow): BountyEventRecord {
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    projects: parseList(row.projects_json),
    channels: parseList(row.channels_json) as BountyEventChannel[],
    guidance: row.guidance,
    rewardOverride: parseOverride(row.reward_override_json),
    endedEarlyAt: row.ended_early_at,
    createdBy: row.created_by,
    endedBy: row.ended_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseOverride(raw: string | null): BountyRewardOverride | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: BountyRewardOverride = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (["s1", "s2", "s3", "s4"].includes(key) && Number.isInteger(value) && (value as number) >= 0) {
        result[key as keyof BountyRewardOverride] = value as number;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
