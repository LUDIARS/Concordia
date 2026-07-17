/**
 * kind 別 Inject マニュアル repository。 delegation invoke の協調コンテキストへ
 * 差し込む「作業マニュアル」を kind ごとに 1 行で持ち、 WebUI (/manuals) から編集する。
 * kind 語彙は spec/feature/task-workflow.md §2.1 の kind (forum タグ) と同語彙。
 */

import type Database from "better-sqlite3";

export const INJECT_MANUAL_KINDS = ["設計相談", "実装", "レビュー", "テスト", "雑用"] as const;
export type InjectManualKind = (typeof INJECT_MANUAL_KINDS)[number];

export function isInjectManualKind(value: string): value is InjectManualKind {
  return (INJECT_MANUAL_KINDS as readonly string[]).includes(value);
}

export interface InjectManualRow {
  kind: string;
  content: string;
  updated_at: number;
}

export class InjectManualsRepo {
  constructor(private readonly db: Database.Database) {}

  /** 全マニュアル。 kind の固定語彙順 (設計相談 → 実装 → レビュー → テスト → 雑用) で返す。 */
  list(): InjectManualRow[] {
    const rows = this.db.prepare(`SELECT * FROM inject_manuals`).all() as InjectManualRow[];
    const order = new Map<string, number>(INJECT_MANUAL_KINDS.map((k, i) => [k, i]));
    return rows.sort(
      (a, b) => (order.get(a.kind) ?? INJECT_MANUAL_KINDS.length) - (order.get(b.kind) ?? INJECT_MANUAL_KINDS.length),
    );
  }

  get(kind: string): InjectManualRow | null {
    return (
      (this.db.prepare(`SELECT * FROM inject_manuals WHERE kind = ?`).get(kind) as InjectManualRow | undefined) ?? null
    );
  }

  upsert(kind: string, content: string, now = Date.now()): InjectManualRow {
    this.db
      .prepare(
        `INSERT INTO inject_manuals(kind, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(kind, content, now);
    return this.get(kind)!;
  }

  /** 既定マニュアルの冪等 seed 用。 既存行があれば content を上書きしない (ユーザ編集尊重)。 */
  ensureDefault(kind: string, content: string, now = Date.now()): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO inject_manuals(kind, content, updated_at) VALUES (?, ?, ?)`)
      .run(kind, content, now);
  }
}
