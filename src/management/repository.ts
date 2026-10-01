import type { Database } from "better-sqlite3";
import {
  ACTIVE_STATES,
  OPEN_STATES,
  type Decision,
  type ManagementEvent,
  type ManagementRequest,
  type Mission,
  type RequestState,
} from "./domain.js";

/**
 * CDGD マネジメント層の永続化。 表は migration 120 (management-sidecar) が作る。
 * 依頼の遷移は revision の CAS、 冪等キーは UNIQUE 制約で守る (CC-MGMT-INV-02)。
 */

type Row = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toMission(row: Row): Mission {
  return {
    id: row.id as string,
    name: row.name as string,
    department_id: (row.department_id as string | null) ?? null,
    project_codes: json<string[]>(row.project_codes, []),
    goal: row.goal as string,
    allowed_kinds: json<string[]>(row.allowed_kinds, []),
    human_gate_kinds: json<string[]>(row.human_gate_kinds, []),
    requires_effect_check: row.requires_effect_check === 1,
    max_open_requests: row.max_open_requests as number,
    daily_request_limit: row.daily_request_limit as number,
    review_interval_minutes: row.review_interval_minutes as number,
    status: row.status as Mission["status"],
    token_hash: row.token_hash as string,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    revision: row.revision as number,
  };
}

function toRequest(row: Row): ManagementRequest {
  return {
    id: row.id as string,
    mission_id: row.mission_id as string,
    request_key: row.request_key as string,
    kind: row.kind as string,
    project_code: row.project_code as string,
    target_key: row.target_key as string,
    purpose: row.purpose as string,
    completion_criteria: row.completion_criteria as string,
    evidence_seqs: json<number[]>(row.evidence_seqs, []),
    rationale: row.rationale as string,
    state: row.state as RequestState,
    attached_to: (row.attached_to as string | null) ?? null,
    session_id: (row.session_id as string | null) ?? null,
    spawn_id: (row.spawn_id as string | null) ?? null,
    launch_deadline_at: (row.launch_deadline_at as number | null) ?? null,
    outcome_summary: (row.outcome_summary as string | null) ?? null,
    outcome_refs: json<string[]>(row.outcome_refs, []),
    human_note: (row.human_note as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    revision: row.revision as number,
  };
}

function toDecision(row: Row): Decision {
  return {
    id: row.id as string,
    mission_id: row.mission_id as string,
    decision_key: row.decision_key as string,
    verdict: row.verdict as Decision["verdict"],
    evidence_seqs: json<number[]>(row.evidence_seqs, []),
    rationale: row.rationale as string,
    request_id: (row.request_id as string | null) ?? null,
    created_at: row.created_at as number,
  };
}

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export interface MissionWrite {
  name: string;
  department_id: string | null;
  project_codes: string[];
  goal: string;
  allowed_kinds: string[];
  human_gate_kinds: string[];
  requires_effect_check: boolean;
  max_open_requests: number;
  daily_request_limit: number;
  review_interval_minutes: number;
}

export interface RequestPatch {
  state?: RequestState;
  session_id?: string | null;
  spawn_id?: string | null;
  launch_deadline_at?: number | null;
  outcome_summary?: string | null;
  outcome_refs?: string[];
  human_note?: string | null;
  error?: string | null;
}

export class ManagementRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── missions ───────────────────────────────────────────────

  insertMission(id: string, input: MissionWrite, tokenHash: string, now: number): Mission {
    this.db.prepare(`INSERT INTO management_missions (
      id, name, department_id, project_codes, goal, allowed_kinds, human_gate_kinds, requires_effect_check,
      max_open_requests, daily_request_limit, review_interval_minutes, status, token_hash,
      acknowledged_seq, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, 1)`).run(
      id, input.name, input.department_id, JSON.stringify(input.project_codes), input.goal,
      JSON.stringify(input.allowed_kinds), JSON.stringify(input.human_gate_kinds), input.requires_effect_check ? 1 : 0,
      input.max_open_requests, input.daily_request_limit, input.review_interval_minutes, tokenHash, now, now,
    );
    return this.findMission(id)!;
  }

  updateMission(id: string, input: MissionWrite, now: number): Mission | null {
    this.db.prepare(`UPDATE management_missions SET name=?, department_id=?, project_codes=?, goal=?,
      allowed_kinds=?, human_gate_kinds=?, requires_effect_check=?, max_open_requests=?, daily_request_limit=?,
      review_interval_minutes=?, updated_at=?, revision=revision+1 WHERE id=?`).run(
      input.name, input.department_id, JSON.stringify(input.project_codes), input.goal,
      JSON.stringify(input.allowed_kinds), JSON.stringify(input.human_gate_kinds), input.requires_effect_check ? 1 : 0,
      input.max_open_requests, input.daily_request_limit, input.review_interval_minutes, now, id,
    );
    return this.findMission(id);
  }

  setMissionStatus(id: string, status: Mission["status"], now: number): Mission | null {
    this.db.prepare("UPDATE management_missions SET status=?, updated_at=?, revision=revision+1 WHERE id=?")
      .run(status, now, id);
    return this.findMission(id);
  }

  setMissionToken(id: string, tokenHash: string, now: number): Mission | null {
    this.db.prepare("UPDATE management_missions SET token_hash=?, updated_at=?, revision=revision+1 WHERE id=?")
      .run(tokenHash, now, id);
    return this.findMission(id);
  }

  findMission(id: string): Mission | null {
    const row = this.db.prepare("SELECT * FROM management_missions WHERE id = ?").get(id) as Row | undefined;
    return row ? toMission(row) : null;
  }

  findMissionByTokenHash(hash: string): Mission | null {
    const row = this.db.prepare("SELECT * FROM management_missions WHERE token_hash = ?").get(hash) as Row | undefined;
    return row ? toMission(row) : null;
  }

  listMissions(): Mission[] {
    return (this.db.prepare("SELECT * FROM management_missions ORDER BY created_at DESC").all() as Row[]).map(toMission);
  }

  acknowledgedSeq(missionId: string): number {
    const row = this.db.prepare("SELECT acknowledged_seq FROM management_missions WHERE id = ?").get(missionId) as
      { acknowledged_seq: number } | undefined;
    return row?.acknowledged_seq ?? 0;
  }

  /** 前進だけを許す。 戻す更新は無視する。 */
  advanceAcknowledged(missionId: string, seq: number, now: number): number {
    this.db.prepare(`UPDATE management_missions SET acknowledged_seq=?, updated_at=?
      WHERE id=? AND acknowledged_seq < ?`).run(seq, now, missionId, seq);
    return this.acknowledgedSeq(missionId);
  }

  // ── events ─────────────────────────────────────────────────

  findEventByKey(key: string): ManagementEvent | null {
    return (this.db.prepare("SELECT * FROM management_events WHERE event_key = ?").get(key) as ManagementEvent | undefined) ?? null;
  }

  insertEvent(event: Omit<ManagementEvent, "seq">): ManagementEvent {
    const info = this.db.prepare(`INSERT INTO management_events (
      event_key, source, kind, project_code, target_key, origin, parent_request_id, summary, ref_url, observed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.event_key, event.source, event.kind, event.project_code, event.target_key, event.origin,
      event.parent_request_id, event.summary, event.ref_url, event.observed_at, event.created_at,
    );
    return { ...event, seq: Number(info.lastInsertRowid) };
  }

  eventsForProjects(projects: readonly string[], afterSeq: number, limit: number): ManagementEvent[] {
    if (projects.length === 0) return [];
    return this.db.prepare(`SELECT * FROM management_events WHERE project_code IN (${placeholders(projects.length)})
      AND seq > ? ORDER BY seq ASC LIMIT ?`).all(...projects, afterSeq, limit) as ManagementEvent[];
  }

  eventsBySeq(projects: readonly string[], seqs: readonly number[]): ManagementEvent[] {
    if (projects.length === 0 || seqs.length === 0) return [];
    return this.db.prepare(`SELECT * FROM management_events WHERE project_code IN (${placeholders(projects.length)})
      AND seq IN (${placeholders(seqs.length)}) ORDER BY seq`).all(...projects, ...seqs) as ManagementEvent[];
  }

  /**
   * 判断が必要な seq。 Cc 自身の記録 (origin=system) は依頼の経過報告なので判断を求めない。
   */
  pendingSeqs(projects: readonly string[], afterSeq: number, uptoSeq: number): number[] {
    if (projects.length === 0) return [];
    return (this.db.prepare(`SELECT seq FROM management_events WHERE project_code IN (${placeholders(projects.length)})
      AND seq > ? AND seq <= ? AND origin <> 'system' ORDER BY seq`).all(...projects, afterSeq, uptoSeq) as Array<{ seq: number }>)
      .map((r) => r.seq);
  }

  countPending(projects: readonly string[], afterSeq: number): number {
    if (projects.length === 0) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM management_events WHERE project_code IN (${placeholders(projects.length)})
      AND seq > ?`).get(...projects, afterSeq) as { n: number };
    return row.n;
  }

  sourceLastSeen(projects: readonly string[]): Array<{ source: string; last_observed_at: number; last_seq: number }> {
    if (projects.length === 0) return [];
    return this.db.prepare(`SELECT source, MAX(observed_at) AS last_observed_at, MAX(seq) AS last_seq
      FROM management_events WHERE project_code IN (${placeholders(projects.length)}) GROUP BY source ORDER BY source`)
      .all(...projects) as Array<{ source: string; last_observed_at: number; last_seq: number }>;
  }

  // ── decisions ──────────────────────────────────────────────

  findDecision(missionId: string, key: string): Decision | null {
    const row = this.db.prepare("SELECT * FROM management_decisions WHERE mission_id = ? AND decision_key = ?")
      .get(missionId, key) as Row | undefined;
    return row ? toDecision(row) : null;
  }

  insertDecision(decision: Decision): Decision {
    this.db.prepare(`INSERT INTO management_decisions (id, mission_id, decision_key, verdict, evidence_seqs, rationale, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      decision.id, decision.mission_id, decision.decision_key, decision.verdict,
      JSON.stringify(decision.evidence_seqs), decision.rationale, decision.request_id, decision.created_at,
    );
    return decision;
  }

  recentDecisions(missionId: string, limit: number): Decision[] {
    return (this.db.prepare("SELECT * FROM management_decisions WHERE mission_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(missionId, limit) as Row[]).map(toDecision);
  }

  /** 判断の根拠に含まれた seq 集合 (依頼は自動で判断を残すので判断表だけを見る)。 */
  coveredSeqs(missionId: string, afterSeq: number): Set<number> {
    const covered = new Set<number>();
    const rows = this.db.prepare("SELECT evidence_seqs FROM management_decisions WHERE mission_id = ?")
      .all(missionId) as Array<{ evidence_seqs: string }>;
    for (const row of rows) {
      for (const seq of json<number[]>(row.evidence_seqs, [])) if (seq > afterSeq) covered.add(seq);
    }
    return covered;
  }

  // ── requests ───────────────────────────────────────────────

  findRequest(id: string): ManagementRequest | null {
    const row = this.db.prepare("SELECT * FROM management_requests WHERE id = ?").get(id) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  findRequestByKey(missionId: string, key: string): ManagementRequest | null {
    const row = this.db.prepare("SELECT * FROM management_requests WHERE mission_id = ? AND request_key = ?")
      .get(missionId, key) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  /** 同じ対象・種別の未完了依頼 (任務をまたいで照合する)。 */
  findOpenForTarget(project: string, targetKey: string, kind: string): ManagementRequest | null {
    const row = this.db.prepare(`SELECT * FROM management_requests WHERE project_code = ? AND target_key = ? AND kind = ?
      AND state IN (${placeholders(OPEN_STATES.length)}) ORDER BY created_at ASC LIMIT 1`)
      .get(project, targetKey, kind, ...OPEN_STATES) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  countActive(missionId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM management_requests WHERE mission_id = ?
      AND state IN (${placeholders(ACTIVE_STATES.length)})`).get(missionId, ...ACTIVE_STATES) as { n: number };
    return row.n;
  }

  countSince(missionId: string, since: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM management_requests WHERE mission_id = ? AND created_at >= ?
      AND state NOT IN ('attached', 'rejected')`).get(missionId, since) as { n: number };
    return row.n;
  }

  insertRequest(request: ManagementRequest): ManagementRequest {
    this.db.prepare(`INSERT INTO management_requests (
      id, mission_id, request_key, kind, project_code, target_key, purpose, completion_criteria, evidence_seqs, rationale,
      state, attached_to, session_id, spawn_id, launch_deadline_at, outcome_summary, outcome_refs, human_note, error,
      created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      request.id, request.mission_id, request.request_key, request.kind, request.project_code, request.target_key,
      request.purpose, request.completion_criteria, JSON.stringify(request.evidence_seqs), request.rationale,
      request.state, request.attached_to, request.session_id, request.spawn_id, request.launch_deadline_at,
      request.outcome_summary, JSON.stringify(request.outcome_refs), request.human_note, request.error,
      request.created_at, request.updated_at, request.revision,
    );
    return request;
  }

  /** CAS 遷移。 他者が先に更新していたら null。 */
  transition(row: ManagementRequest, patch: RequestPatch, now: number): ManagementRequest | null {
    const next: ManagementRequest = { ...row, ...patch, updated_at: now, revision: row.revision + 1 };
    const info = this.db.prepare(`UPDATE management_requests SET state=?, session_id=?, spawn_id=?, launch_deadline_at=?,
      outcome_summary=?, outcome_refs=?, human_note=?, error=?, updated_at=?, revision=?
      WHERE id=? AND revision=?`).run(
      next.state, next.session_id, next.spawn_id, next.launch_deadline_at, next.outcome_summary,
      JSON.stringify(next.outcome_refs), next.human_note, next.error, now, next.revision, row.id, row.revision,
    );
    return info.changes === 1 ? next : null;
  }

  listRequestsByStates(states: readonly RequestState[], limit: number): ManagementRequest[] {
    return (this.db.prepare(`SELECT * FROM management_requests WHERE state IN (${placeholders(states.length)})
      ORDER BY created_at ASC LIMIT ?`).all(...states, limit) as Row[]).map(toRequest);
  }

  listRequests(missionId: string | null, limit: number): ManagementRequest[] {
    const rows = missionId
      ? this.db.prepare("SELECT * FROM management_requests WHERE mission_id = ? ORDER BY created_at DESC LIMIT ?").all(missionId, limit)
      : this.db.prepare("SELECT * FROM management_requests ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(toRequest);
  }

  /** 終わっていない依頼 (文脈用)。 */
  unfinishedRequests(missionId: string, limit: number): ManagementRequest[] {
    return (this.db.prepare(`SELECT * FROM management_requests WHERE mission_id = ?
      AND state NOT IN ('rejected', 'launch_failed', 'effect_confirmed', 'effect_not_met')
      ORDER BY created_at DESC LIMIT ?`).all(missionId, limit) as Row[]).map(toRequest);
  }
}
