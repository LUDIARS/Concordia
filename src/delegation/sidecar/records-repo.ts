/**
 * Sidecar の振り分け判定と起動可否の記録 (adapter)。
 *
 * 分類器の誤判定・拒否・再試行を後から数えるための台帳で、判断そのものは持たない
 * (判断は route-policy.ts / gate.ts の純関数)。 秘密や依頼本文は保存しない —
 * input_json は判定入力の構造化値だけ。
 *
 * @implements spec/feature/astra-with-sidecar.md §費用の根拠と評価
 */

import type { Database } from "better-sqlite3";
import type { SidecarRouteDecision, SidecarRouteInput } from "./route-policy.js";

export type SidecarInvokeOutcome = "allowed" | "rejected" | "launch_failed";

export interface SidecarRouteDecisionRow {
  id: number;
  parent_session_id: string;
  task_reference: string | null;
  request_version: number | null;
  route: SidecarRouteDecision["route"];
  reason: string;
  uncertainty: SidecarRouteDecision["uncertainty"];
  source: SidecarRouteDecision["source"];
  classifier_model: string | null;
  budget_minutes: number | null;
  input_json: string;
  created_at: number;
}

export interface SidecarInvokeEventRow {
  id: number;
  parent_session_id: string;
  request_key: string | null;
  run_id: string | null;
  outcome: SidecarInvokeOutcome;
  code: string | null;
  detail: string | null;
  created_at: number;
}

export class SidecarRecordsRepo {
  constructor(private readonly db: Database) {}

  recordRouteDecision(input: {
    parentSessionId: string;
    taskReference: string | null;
    requestVersion: number | null;
    decision: SidecarRouteDecision & { classifierModel: string | null };
    routeInput: SidecarRouteInput;
    now: number;
  }): SidecarRouteDecisionRow {
    const result = this.db.prepare(
      `INSERT INTO sidecar_route_decisions
        (parent_session_id, task_reference, request_version, route, reason, uncertainty, source,
         classifier_model, budget_minutes, input_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.parentSessionId,
      input.taskReference,
      input.requestVersion,
      input.decision.route,
      input.decision.reason,
      input.decision.uncertainty,
      input.decision.source,
      input.decision.classifierModel,
      input.decision.budgetMinutes,
      JSON.stringify(input.routeInput),
      input.now,
    );
    return this.db.prepare(`SELECT * FROM sidecar_route_decisions WHERE id = ?`)
      .get(result.lastInsertRowid) as SidecarRouteDecisionRow;
  }

  recordInvokeEvent(input: {
    parentSessionId: string;
    requestKey: string | null;
    runId: string | null;
    outcome: SidecarInvokeOutcome;
    code: string | null;
    detail: string | null;
    now: number;
  }): void {
    this.db.prepare(
      `INSERT INTO sidecar_invoke_events (parent_session_id, request_key, run_id, outcome, code, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.parentSessionId,
      input.requestKey,
      input.runId,
      input.outcome,
      input.code,
      input.detail?.slice(0, 2000) ?? null,
      input.now,
    );
  }

  listRouteDecisions(parentSessionId: string, limit = 100): SidecarRouteDecisionRow[] {
    return this.db.prepare(
      `SELECT * FROM sidecar_route_decisions WHERE parent_session_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(parentSessionId, limit) as SidecarRouteDecisionRow[];
  }

  listInvokeEvents(parentSessionId: string, limit = 100): SidecarInvokeEventRow[] {
    return this.db.prepare(
      `SELECT * FROM sidecar_invoke_events WHERE parent_session_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(parentSessionId, limit) as SidecarInvokeEventRow[];
  }
}
