import {
  availableHumanActions,
  boundedInt,
  canRecordOutcome,
  decideIntake,
  humanTransition,
  needsHumanAttention,
  ManagementInputError,
  optionalKey,
  optionalText,
  requireKey,
  requireKind,
  requireKindList,
  requireOrigin,
  requireProject,
  requireProjectList,
  requireSeqs,
  requireSource,
  requireStringList,
  requireText,
  requireVerdict,
  startOfJstDay,
  SUMMARY_LIMIT,
  uncoveredSeqs,
  type Decision,
  type HumanAction,
  type ManagementEvent,
  type ManagementRequest,
  type Mission,
} from "./domain.js";
import type { ManagementRepository, MissionWrite } from "./repository.js";

/**
 * CDGD マネジメント層の use case。 認可 (どの主体が呼べるか) は HTTP 境界で分け、
 * ここは「任務の範囲で受け付けてよいか」「状態をどう進めるか」を決めて保存する。
 *
 * @implements spec/feature/cdgd-management.md CC-MGMT-01〜05
 */

export interface ManagementPorts {
  now: () => number;
  id: () => string;
  newToken: () => string;
  hashToken: (token: string) => string;
  /** 既存担当セッションへの追加情報 (送信試行。 配達は確認しない)。 */
  inject: (sessionId: string, text: string) => void;
  /** 対象プロジェクトで稼働中のセッション (照合の参考情報)。 */
  liveSessions: (projects: readonly string[]) => Array<{ id: string; project: string | null; branch: string | null; current_task: string | null }>;
  departmentExists: (id: string) => boolean;
}

export class ManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429) {
    super(message);
  }
}

export interface DeliveryItem {
  request: ManagementRequest;
  mission_name: string;
  actions: HumanAction[];
}

export interface SubmitResult {
  request: ManagementRequest;
  created: boolean;
}

const CC_SOURCE = "cc";

export class ManagementService {
  constructor(readonly repo: ManagementRepository, private readonly ports: ManagementPorts) {}

  // ── 任務 (CC-MGMT-01) ───────────────────────────────────────

  createMission(body: Record<string, unknown>): { mission: Mission; token: string } {
    const input = this.readMission(body);
    const token = this.ports.newToken();
    const mission = this.repo.insertMission(this.ports.id(), input, this.ports.hashToken(token), this.ports.now());
    return { mission, token };
  }

  updateMission(id: string, body: Record<string, unknown>): Mission {
    const current = this.mustMission(id);
    const merged = { ...this.missionToBody(current), ...body };
    return this.repo.updateMission(id, this.readMission(merged), this.ports.now())!;
  }

  setMissionStatus(id: string, status: Mission["status"]): Mission {
    this.mustMission(id);
    return this.repo.setMissionStatus(id, status, this.ports.now())!;
  }

  rotateToken(id: string): { mission: Mission; token: string } {
    this.mustMission(id);
    const token = this.ports.newToken();
    const mission = this.repo.setMissionToken(id, this.ports.hashToken(token), this.ports.now())!;
    return { mission, token };
  }

  authenticate(token: string | null): Mission {
    if (!token) throw new ManagementError("unauthorized", "Bearer トークンが必要です", 401);
    const mission = this.repo.findMissionByTokenHash(this.ports.hashToken(token));
    if (!mission) throw new ManagementError("unauthorized", "トークンが無効です", 401);
    return mission;
  }

  // ── 変更の受付と配信 (CC-MGMT-02) ──────────────────────────

  ingestEvent(body: Record<string, unknown>): { event: ManagementEvent; created: boolean } {
    const now = this.ports.now();
    const input = {
      event_key: requireKey(body.event_key, "event_key"),
      source: requireSource(body.source),
      kind: requireKind(body.kind),
      project_code: requireProject(body.project_code),
      target_key: optionalKey(body.target_key, "target_key"),
      origin: requireOrigin(body.origin),
      parent_request_id: optionalKey(body.parent_request_id, "parent_request_id"),
      summary: requireText(body.summary, "summary", SUMMARY_LIMIT),
      ref_url: optionalText(body.ref_url, "ref_url", 1_000),
      observed_at: boundedInt(body.observed_at, "observed_at", now, 0, Number.MAX_SAFE_INTEGER),
    };
    if (input.source === CC_SOURCE) throw new ManagementError("reserved_source", "source=cc は Cc 自身の記録に予約されています", 400);
    return this.repo.transaction(() => {
      const existing = this.repo.findEventByKey(input.event_key);
      if (existing) {
        const same = existing.source === input.source && existing.kind === input.kind
          && existing.project_code === input.project_code && existing.origin === input.origin
          && existing.summary === input.summary && existing.target_key === input.target_key;
        if (!same) throw new ManagementError("event_key_conflict", "event_key が別の内容で使われています", 409);
        return { event: existing, created: false };
      }
      return { event: this.repo.insertEvent({ ...input, created_at: now }), created: true };
    });
  }

  changes(mission: Mission, after: number | null, limit: number) {
    const from = after ?? this.repo.acknowledgedSeq(mission.id);
    const events = this.repo.eventsForProjects(mission.project_codes, from, limit);
    return {
      after: from,
      events,
      next_after: events.length ? events[events.length - 1]!.seq : from,
      sources: this.repo.sourceLastSeen(mission.project_codes),
    };
  }

  context(mission: Mission) {
    const acknowledged = this.repo.acknowledgedSeq(mission.id);
    return {
      mission: publicMission(mission),
      acknowledged_seq: acknowledged,
      pending_changes: this.repo.countPending(mission.project_codes, acknowledged),
      requests: this.repo.unfinishedRequests(mission.id, 50),
      decisions: this.repo.recentDecisions(mission.id, 20),
      live_sessions: this.ports.liveSessions(mission.project_codes),
      sources: this.repo.sourceLastSeen(mission.project_codes),
      limits: {
        active_requests: this.repo.countActive(mission.id),
        max_open_requests: mission.max_open_requests,
        requests_today: this.repo.countSince(mission.id, startOfJstDay(this.ports.now())),
        daily_request_limit: mission.daily_request_limit,
      },
    };
  }

  // ── 判断と処理済み位置 (R5 / CC-MGMT-INV-04) ───────────────

  recordDecision(mission: Mission, body: Record<string, unknown>): { decision: Decision; created: boolean } {
    this.requireActive(mission);
    const key = requireKey(body.decision_key, "decision_key");
    const verdict = requireVerdict(body.verdict);
    const seqs = requireSeqs(body.evidence_seqs);
    const rationale = requireText(body.rationale, "rationale");
    return this.repo.transaction(() => {
      const existing = this.repo.findDecision(mission.id, key);
      if (existing) {
        if (existing.verdict !== verdict || existing.rationale !== rationale
          || existing.evidence_seqs.join(",") !== seqs.join(",")) {
          throw new ManagementError("decision_key_conflict", "decision_key が別の内容で使われています", 409);
        }
        return { decision: existing, created: false };
      }
      this.requireVisible(mission, seqs);
      const decision = this.repo.insertDecision({
        id: this.ports.id(), mission_id: mission.id, decision_key: key, verdict,
        evidence_seqs: seqs, rationale, request_id: null, created_at: this.ports.now(),
      });
      return { decision, created: true };
    });
  }

  acknowledge(mission: Mission, body: Record<string, unknown>): { acknowledged_seq: number } {
    const upto = boundedInt(body.seq, "seq", 0, 1, Number.MAX_SAFE_INTEGER);
    return this.repo.transaction(() => {
      const current = this.repo.acknowledgedSeq(mission.id);
      if (upto <= current) return { acknowledged_seq: current };
      const pending = this.repo.pendingSeqs(mission.project_codes, current, upto);
      const missing = uncoveredSeqs(pending, this.repo.coveredSeqs(mission.id, current));
      if (missing.length) {
        throw new ManagementError("undecided_changes",
          `判断も依頼も記録されていない変更があります: ${missing.slice(0, 20).join(", ")}`, 409);
      }
      return { acknowledged_seq: this.repo.advanceAcknowledged(mission.id, upto, this.ports.now()) };
    });
  }

  // ── 依頼 (CC-MGMT-04) ──────────────────────────────────────

  submitRequest(mission: Mission, body: Record<string, unknown>): SubmitResult {
    const now = this.ports.now();
    const input = {
      request_key: requireKey(body.request_key, "request_key"),
      kind: requireKind(body.kind),
      project_code: requireProject(body.project_code),
      target_key: requireKey(body.target_key, "target_key"),
      purpose: requireText(body.purpose, "purpose"),
      completion_criteria: requireText(body.completion_criteria, "completion_criteria"),
      evidence_seqs: requireSeqs(body.evidence_seqs),
      rationale: requireText(body.rationale, "rationale"),
    };
    let attachedTo: ManagementRequest | null = null;
    const result = this.repo.transaction((): SubmitResult => {
      const existing = this.repo.findRequestByKey(mission.id, input.request_key);
      if (existing) {
        const same = existing.kind === input.kind && existing.project_code === input.project_code
          && existing.target_key === input.target_key && existing.purpose === input.purpose
          && existing.completion_criteria === input.completion_criteria
          && existing.evidence_seqs.join(",") === input.evidence_seqs.join(",");
        if (!same) throw new ManagementError("request_key_conflict", "request_key が別の依頼で使われています", 409);
        return { request: existing, created: false };
      }
      const evidence = this.repo.eventsBySeq(mission.project_codes, input.evidence_seqs);
      const verdict = decideIntake({
        mission,
        kind: input.kind,
        project_code: input.project_code,
        evidence,
        evidenceSeqs: input.evidence_seqs,
        sameTargetOpen: this.repo.findOpenForTarget(input.project_code, input.target_key, input.kind),
        activeCount: this.repo.countActive(mission.id),
        todayCount: this.repo.countSince(mission.id, startOfJstDay(now)),
      });
      if (verdict.kind === "reject") {
        throw new ManagementError(verdict.code, verdict.message, verdict.code === "mission_stopped" ? 403 : 409);
      }
      if (verdict.kind === "attach") attachedTo = verdict.parent;
      const request = this.repo.insertRequest({
        id: this.ports.id(), mission_id: mission.id, ...input,
        state: verdict.kind === "attach" ? "attached" : verdict.state,
        attached_to: verdict.kind === "attach" ? verdict.parent.id : null,
        session_id: verdict.kind === "attach" ? verdict.parent.session_id : null,
        spawn_id: null, launch_deadline_at: null, outcome_summary: null, outcome_refs: [],
        human_note: null, error: null, created_at: now, updated_at: now, revision: 1,
        delivered_revision: 0, discord_message_id: null,
      });
      this.repo.insertDecision({
        id: this.ports.id(), mission_id: mission.id, decision_key: `request:${input.request_key}`,
        verdict: verdict.kind === "attach" ? "attach" : "request", evidence_seqs: input.evidence_seqs,
        rationale: input.rationale, request_id: request.id, created_at: now,
      });
      this.appendLifecycle(request, `request_${request.state}`, `依頼 ${request.request_key} を受け付けました (${request.state})`);
      return { request, created: true };
    });
    const parent = attachedTo as ManagementRequest | null;
    if (result.created && parent?.session_id && parent.state === "dispatched") {
      this.ports.inject(parent.session_id, attachText(result.request));
    }
    return result;
  }

  getRequest(mission: Mission, keyOrId: string): ManagementRequest {
    const request = this.repo.findRequestByKey(mission.id, keyOrId) ?? this.repo.findRequest(keyOrId);
    if (!request || request.mission_id !== mission.id) throw new ManagementError("not_found", "依頼が見つかりません", 404);
    return request;
  }

  // ── 成果・受入 (CC-MGMT-05) ─────────────────────────────────

  /** 担当セッション本人だけが成果を記録できる。 */
  recordOutcome(requestId: string, body: Record<string, unknown>): ManagementRequest {
    const sessionId = requireText(body.session_id, "session_id", 200);
    const summary = requireText(body.summary, "summary", SUMMARY_LIMIT);
    const refs = requireStringList(body.refs, "refs", 20);
    const request = this.repo.findRequest(requestId);
    if (!request) throw new ManagementError("not_found", "依頼が見つかりません", 404);
    if (request.session_id !== sessionId) throw new ManagementError("not_assignee", "担当セッションではありません", 403);
    if (!canRecordOutcome(request.state)) {
      throw new ManagementError("invalid_state", `状態 ${request.state} では成果を記録できません`, 409);
    }
    const next = this.repo.transition(request, { state: "outcome_recorded", outcome_summary: summary, outcome_refs: refs }, this.ports.now());
    if (!next) throw new ManagementError("conflict", "依頼が同時に更新されました。読み直してください", 409);
    this.appendLifecycle(next, "request_outcome_recorded", `依頼 ${next.request_key} の成果が記録されました (受入待ち)`);
    return next;
  }

  /** 人間の管理面からの操作 (CC-MGMT-INV-07)。 */
  humanAction(requestId: string, action: HumanAction, body: Record<string, unknown>): ManagementRequest {
    const actor = requireText(body.actor, "actor", 200);
    const note = optionalText(body.note, "note");
    const request = this.repo.findRequest(requestId);
    if (!request) throw new ManagementError("not_found", "依頼が見つかりません", 404);
    const mission = this.mustMission(request.mission_id);
    const nextState = humanTransition(request.state, action, mission.requires_effect_check);
    if (!nextState) throw new ManagementError("invalid_state", `状態 ${request.state} では ${action} できません`, 409);
    const next = this.repo.transition(request, {
      state: nextState,
      human_note: [request.human_note, `${action} by ${actor}${note ? `: ${note}` : ""}`].filter(Boolean).join("\n"),
    }, this.ports.now());
    if (!next) throw new ManagementError("conflict", "依頼が同時に更新されました。読み直してください", 409);
    this.appendLifecycle(next, `request_${nextState}`, `依頼 ${next.request_key} を人間が ${action} しました`);
    return next;
  }

  /**
   * 人間向けカードの配達候補 (CC-MGMT-06)。 カードが要らない変化はここで配達済みにして
   * 次回から返さない。 カードがある依頼は状態が何であれ編集対象として返す。
   */
  deliveries(limit = 20): DeliveryItem[] {
    const items: DeliveryItem[] = [];
    for (const request of this.repo.undeliveredRequests(limit * 2)) {
      const mission = this.repo.findMission(request.mission_id);
      const effect = mission?.requires_effect_check ?? false;
      if (!request.discord_message_id && !needsHumanAttention(request.state, effect)) {
        this.repo.markDelivered(request.id, request.revision, null);
        continue;
      }
      items.push({ request, mission_name: mission?.name ?? "(削除済み任務)", actions: availableHumanActions(request.state, effect) });
      if (items.length >= limit) break;
    }
    return items;
  }

  recordDelivery(id: string, body: Record<string, unknown>): ManagementRequest {
    const revision = boundedInt(body.revision, "revision", 0, 1, Number.MAX_SAFE_INTEGER);
    const messageId = body.message_id === undefined || body.message_id === null ? null : requireText(body.message_id, "message_id", 32);
    if (messageId !== null && !/^\d{1,25}$/.test(messageId)) throw new ManagementInputError("invalid_input", "message_id が不正です");
    const request = this.repo.findRequest(id);
    if (!request) throw new ManagementError("not_found", "依頼が見つかりません", 404);
    return this.repo.markDelivered(id, revision, messageId)!;
  }

  /** 管理画面用: 依頼と、その状態で押せる操作。 */
  listRequestsWithActions(missionId: string | null, limit: number): DeliveryItem[] {
    const missions = new Map(this.repo.listMissions().map((m) => [m.id, m]));
    return this.repo.listRequests(missionId, limit).map((request) => {
      const mission = missions.get(request.mission_id);
      return { request, mission_name: mission?.name ?? "(削除済み任務)", actions: availableHumanActions(request.state, mission?.requires_effect_check ?? false) };
    });
  }

  /** Cc 自身の状態変化を変更列へ積む (source=cc, origin=system)。 */
  appendLifecycle(request: ManagementRequest, kind: string, summary: string): void {
    const key = `cc:${request.id}:${request.revision}:${kind}`;
    if (this.repo.findEventByKey(key)) return;
    this.repo.insertEvent({
      event_key: key, source: CC_SOURCE, kind: kind.slice(0, 41), project_code: request.project_code,
      target_key: request.target_key, origin: "system", parent_request_id: request.id,
      summary, ref_url: null, observed_at: this.ports.now(), created_at: this.ports.now(),
    });
  }

  // ── 内部 ──────────────────────────────────────────────────

  private requireActive(mission: Mission): void {
    if (mission.status !== "active") throw new ManagementError("mission_stopped", "任務は停止中です", 403);
  }

  private requireVisible(mission: Mission, seqs: number[]): void {
    const found = this.repo.eventsBySeq(mission.project_codes, seqs);
    if (found.length !== seqs.length) {
      throw new ManagementError("evidence_not_visible", "根拠に任務から見えないイベントが含まれています", 409);
    }
  }

  private mustMission(id: string): Mission {
    const mission = this.repo.findMission(id);
    if (!mission) throw new ManagementError("not_found", "任務が見つかりません", 404);
    return mission;
  }

  private readMission(body: Record<string, unknown>): MissionWrite {
    const departmentId = optionalText(body.department_id, "department_id", 200);
    if (departmentId && !this.ports.departmentExists(departmentId)) {
      throw new ManagementError("department_not_found", "部署が見つかりません", 400);
    }
    const allowed = requireKindList(body.allowed_kinds, "allowed_kinds", true);
    const gated = requireKindList(body.human_gate_kinds ?? [], "human_gate_kinds", true);
    if (allowed.length + gated.length === 0) {
      throw new ManagementInputError("invalid_input", "allowed_kinds か human_gate_kinds のどちらかに 1 件以上必要です");
    }
    return {
      name: requireText(body.name, "name", 100),
      department_id: departmentId,
      project_codes: requireProjectList(body.project_codes),
      goal: requireText(body.goal, "goal"),
      allowed_kinds: allowed.filter((k) => !gated.includes(k)),
      human_gate_kinds: gated,
      requires_effect_check: body.requires_effect_check === true,
      max_open_requests: boundedInt(body.max_open_requests, "max_open_requests", 3, 1, 20),
      daily_request_limit: boundedInt(body.daily_request_limit, "daily_request_limit", 10, 1, 200),
      review_interval_minutes: boundedInt(body.review_interval_minutes, "review_interval_minutes", 60, 5, 1_440),
    };
  }

  private missionToBody(mission: Mission): Record<string, unknown> {
    const { token_hash: _hash, ...rest } = mission;
    return rest as unknown as Record<string, unknown>;
  }
}

/** トークン hash を外へ出さない。 */
export function publicMission(mission: Mission): Omit<Mission, "token_hash"> {
  const { token_hash: _hash, ...rest } = mission;
  return rest;
}

function attachText(request: ManagementRequest): string {
  return [
    `[CDGD マネジメント] 担当中の依頼に追加情報があります (依頼 ${request.attached_to} への合流: ${request.request_key})。`,
    `目的: ${request.purpose}`,
    `完了条件: ${request.completion_criteria}`,
    `理由: ${request.rationale}`,
    "担当範囲内で取り込み、成果記録に反映してください。新しい作業を別途始めないでください。",
  ].join("\n");
}
