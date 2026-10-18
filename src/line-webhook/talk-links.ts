/**
 * トークごとの紐付け (spec/feature/line-webhook-relay.md §トークごとの紐付け)。
 *
 * どのトーク (group / room / user) にどのサービスがつながっているか、 そのうち「ふだんの相手」 は誰か。
 * 「つなぐ」 の応答で linked が返ったときに足し、 unlinked / ボットの退出で消す。
 * 置き場所は line_talk_links (migration 144)。 テストや DB の無い構成向けにメモリ版も持つ。
 *
 * @implements spec/feature/line-webhook-relay.md — トークごとの紐付け
 */

import type Database from "better-sqlite3";
import type { TalkLink } from "./routing.js";

export interface LineTalkLinkRow {
  id: number;
  channel: string;
  talkId: string;
  service: string;
  isDefault: boolean;
  linkedAt: number;
}

export interface LineTalkLinkStore {
  list(): LineTalkLinkRow[];
  forTalk(channel: string, talkId: string): TalkLink[];
  /** 紐付けを足す (既にあれば何もしない)。 そのトークにふだんの相手が無ければ、 これをふだんの相手にする。 */
  link(channel: string, talkId: string, service: string, now: number): void;
  unlink(channel: string, talkId: string, service: string): void;
  clearTalk(channel: string, talkId: string): void;
  /** id の紐付けをそのトークのふだんの相手にする。 無ければ false。 */
  setDefault(id: number): boolean;
  remove(id: number): boolean;
}

interface Row {
  id: number;
  channel: string;
  talk_id: string;
  service: string;
  is_default: number;
  linked_at: number;
}

const toRow = (row: Row): LineTalkLinkRow => ({
  id: row.id,
  channel: row.channel,
  talkId: row.talk_id,
  service: row.service,
  isDefault: row.is_default === 1,
  linkedAt: row.linked_at,
});

export class SqliteLineTalkLinkStore implements LineTalkLinkStore {
  constructor(private readonly db: Database.Database) {}

  list(): LineTalkLinkRow[] {
    return (this.db.prepare(
      `SELECT * FROM line_talk_links ORDER BY channel, talk_id, linked_at, id`,
    ).all() as Row[]).map(toRow);
  }

  forTalk(channel: string, talkId: string): TalkLink[] {
    return (this.db.prepare(
      `SELECT service, is_default FROM line_talk_links WHERE channel = ? AND talk_id = ? ORDER BY linked_at, id`,
    ).all(channel, talkId) as Array<{ service: string; is_default: number }>)
      .map((row) => ({ service: row.service, isDefault: row.is_default === 1 }));
  }

  link(channel: string, talkId: string, service: string, now: number): void {
    this.db.transaction(() => {
      const hasDefault = this.db.prepare(
        `SELECT 1 FROM line_talk_links WHERE channel = ? AND talk_id = ? AND is_default = 1`,
      ).get(channel, talkId) !== undefined;
      this.db.prepare(
        `INSERT INTO line_talk_links (channel, talk_id, service, is_default, linked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel, talk_id, service) DO NOTHING`,
      ).run(channel, talkId, service, hasDefault ? 0 : 1, now);
    })();
  }

  unlink(channel: string, talkId: string, service: string): void {
    this.db.prepare(`DELETE FROM line_talk_links WHERE channel = ? AND talk_id = ? AND service = ?`)
      .run(channel, talkId, service);
  }

  clearTalk(channel: string, talkId: string): void {
    this.db.prepare(`DELETE FROM line_talk_links WHERE channel = ? AND talk_id = ?`).run(channel, talkId);
  }

  setDefault(id: number): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT channel, talk_id FROM line_talk_links WHERE id = ?`).get(id) as
        | { channel: string; talk_id: string }
        | undefined;
      if (!row) return false;
      this.db.prepare(`UPDATE line_talk_links SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE channel = ? AND talk_id = ?`)
        .run(id, row.channel, row.talk_id);
      return true;
    })();
  }

  remove(id: number): boolean {
    return this.db.prepare(`DELETE FROM line_talk_links WHERE id = ?`).run(id).changes > 0;
  }
}

export class MemoryLineTalkLinkStore implements LineTalkLinkStore {
  private rows: LineTalkLinkRow[] = [];
  private nextId = 1;

  list(): LineTalkLinkRow[] {
    return this.rows.map((row) => ({ ...row }));
  }

  forTalk(channel: string, talkId: string): TalkLink[] {
    return this.rows
      .filter((row) => row.channel === channel && row.talkId === talkId)
      .map((row) => ({ service: row.service, isDefault: row.isDefault }));
  }

  link(channel: string, talkId: string, service: string, now: number): void {
    const talk = this.rows.filter((row) => row.channel === channel && row.talkId === talkId);
    if (talk.some((row) => row.service === service)) return;
    const isDefault = !talk.some((row) => row.isDefault);
    this.rows.push({ id: this.nextId++, channel, talkId, service, isDefault, linkedAt: now });
  }

  unlink(channel: string, talkId: string, service: string): void {
    this.rows = this.rows.filter((row) => !(row.channel === channel && row.talkId === talkId && row.service === service));
  }

  clearTalk(channel: string, talkId: string): void {
    this.rows = this.rows.filter((row) => !(row.channel === channel && row.talkId === talkId));
  }

  setDefault(id: number): boolean {
    const target = this.rows.find((row) => row.id === id);
    if (!target) return false;
    for (const row of this.rows) {
      if (row.channel === target.channel && row.talkId === target.talkId) row.isDefault = row.id === id;
    }
    return true;
  }

  remove(id: number): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    return this.rows.length < before;
  }
}
