/**
 * kind 別 Inject マニュアル repository。 delegation invoke の協調コンテキストへ
 * 差し込む「作業マニュアル」を kind ごとに 1 行で持ち、 WebUI (/manuals) から編集する。
 * kind 語彙は spec/feature/task-workflow.md §2.1 の kind (forum タグ) と同語彙。
 */

import type Database from "better-sqlite3";

export const INJECT_MANUAL_KINDS = ["設計相談", "実装", "レビュー", "テスト", "雑用"] as const;
export type InjectManualKind = (typeof INJECT_MANUAL_KINDS)[number];

/**
 * kind「雑用」の既定マニュアル。 パートタイマー (定時起動) が受け取る。
 *
 * 終わり方・作業姿勢は delegation/parttimer-inject.ts の footer が持つので、 ここは
 * 「本文の範囲を超えないための運用ルール」だけに絞る (重複させると本文と矛盾する)。
 * 既定文の差し替えは schema.ts の migration 82 が参照するので、 文言を変えるときは
 * 旧文を残した migration を新しく足す (既存 migration の文字列は書き換えない)。
 */
export const PARTTIMER_CHORE_MANUAL =
  "タスク本文に書かれた範囲だけを実行し、手順を足さない。" +
  "ファイルを変更する指示があるときだけ作業ブランチ → Revisor local PR にする (読み取り・報告だけなら git 操作は不要)。" +
  "サービスの起動・再起動は本文が指示した場合に限り、Excubitor 経由でプロジェクト本体フォルダから行う (worktree / 複製フォルダから起動しない)。" +
  "やることが無かった場合も、その事実を報告する。";

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
