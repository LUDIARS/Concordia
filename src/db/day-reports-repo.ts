import type Database from "better-sqlite3";

export interface DayReportRow {
  date_iso: string;
  generated_at: number;
  summary_md: string;
  bullets: string;             // JSON
  session_count: number;
  total_duration_sec: number;
  metadata: string | null;
}

export class DayReportsRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(row: DayReportRow): void {
    this.db
      .prepare(
        `INSERT INTO day_reports(date_iso, generated_at, summary_md, bullets, session_count, total_duration_sec, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date_iso) DO UPDATE SET
           generated_at = excluded.generated_at,
           summary_md = excluded.summary_md,
           bullets = excluded.bullets,
           session_count = excluded.session_count,
           total_duration_sec = excluded.total_duration_sec,
           metadata = excluded.metadata`,
      )
      .run(
        row.date_iso,
        row.generated_at,
        row.summary_md,
        row.bullets,
        row.session_count,
        row.total_duration_sec,
        row.metadata,
      );
  }

  find(date_iso: string): DayReportRow | null {
    return (
      (this.db.prepare(`SELECT * FROM day_reports WHERE date_iso = ?`).get(date_iso) as DayReportRow | undefined) ??
      null
    );
  }

  list(limit = 30): DayReportRow[] {
    return this.db
      .prepare(`SELECT * FROM day_reports ORDER BY date_iso DESC LIMIT ?`)
      .all(limit) as DayReportRow[];
  }
}
