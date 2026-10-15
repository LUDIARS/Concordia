import type Database from "better-sqlite3";

/**
 * 巡回チャットの service event 受信箱 (spec/feature/patrol-chat.md §5)。
 * 正規化済みの event を永続化し、 source_event_id の UNIQUE で同じ event を一度だけ受ける。
 * eventBus は起床通知であり、 正本はこの表。
 */

export interface ServiceEventRow {
  id: number;
  source_event_id: string;
  service_code: string;
  feature_key: string | null;
  event_kind: string;
  title: string;
  summary: string;
  url: string | null;
  scope_key: string;
  occurred_at: number;
  received_at: number;
  status: "pending" | "consumed" | "ignored";
  consumed_by: string | null;
}

export type ServiceEventInput = Omit<ServiceEventRow, "id" | "received_at" | "status" | "consumed_by">;

export class RuleServiceEventsRepo {
  constructor(private readonly db: Database.Database) {}

  /** 受理できたら行、 同じ source_event_id が既にあれば null。 */
  receive(input: ServiceEventInput, nowSec: number): ServiceEventRow | null {
    const r = this.db
      .prepare(
        `INSERT INTO rule_service_events(
           source_event_id, service_code, feature_key, event_kind, title, summary, url, scope_key, occurred_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_event_id) DO NOTHING`,
      )
      .run(
        input.source_event_id, input.service_code, input.feature_key, input.event_kind, input.title,
        input.summary, input.url, input.scope_key, input.occurred_at, nowSec,
      );
    return Number(r.changes ?? 0) > 0 ? this.find(Number(r.lastInsertRowid)) : null;
  }

  find(id: number): ServiceEventRow | null {
    return (this.db.prepare(`SELECT * FROM rule_service_events WHERE id = ?`).get(id) as ServiceEventRow | undefined) ?? null;
  }

  pending(limit = 50): ServiceEventRow[] {
    return this.db
      .prepare(`SELECT * FROM rule_service_events WHERE status = 'pending' ORDER BY id LIMIT ?`)
      .all(limit) as ServiceEventRow[];
  }

  /** 1 つの rule が消費した印を付ける (pending → consumed)。 二重消費しない。 */
  consume(id: number, consumedBy: string): boolean {
    const r = this.db
      .prepare(`UPDATE rule_service_events SET status = 'consumed', consumed_by = ? WHERE id = ? AND status = 'pending'`)
      .run(consumedBy, id);
    return Number(r.changes ?? 0) > 0;
  }

  /** どの rule にも当たらない古い event を閉じる。 */
  ignoreOlderThan(receivedBeforeSec: number): number {
    const r = this.db
      .prepare(`UPDATE rule_service_events SET status = 'ignored' WHERE status = 'pending' AND received_at < ?`)
      .run(receivedBeforeSec);
    return Number(r.changes ?? 0);
  }
}
