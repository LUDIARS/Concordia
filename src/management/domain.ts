/**
 * CDGD マネジメント層 (dots サイドカー) の業務用語・入力規則・遷移。
 * I/O を持たない純関数だけを置く。
 *
 * @implements spec/feature/cdgd-management.md
 */

export type MissionStatus = "active" | "stopped";
export type EventOrigin = "human" | "ai" | "system";
export type DecisionVerdict = "request" | "wait" | "skip" | "investigate" | "attach";
export type RequestState =
  | "waiting_human"
  | "rejected"
  | "queued"
  | "launching"
  | "launch_unknown"
  | "launch_failed"
  | "attached"
  | "dispatched"
  | "execution_finished"
  | "outcome_recorded"
  | "accepted"
  | "effect_confirmed"
  | "effect_not_met";

export interface Mission {
  id: string;
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
  status: MissionStatus;
  token_hash: string;
  created_at: number;
  updated_at: number;
  revision: number;
}

export interface ManagementEvent {
  seq: number;
  event_key: string;
  source: string;
  kind: string;
  project_code: string;
  target_key: string | null;
  origin: EventOrigin;
  parent_request_id: string | null;
  summary: string;
  ref_url: string | null;
  observed_at: number;
  created_at: number;
}

export interface Decision {
  id: string;
  mission_id: string;
  decision_key: string;
  verdict: DecisionVerdict;
  evidence_seqs: number[];
  rationale: string;
  request_id: string | null;
  created_at: number;
}

export interface ManagementRequest {
  id: string;
  mission_id: string;
  request_key: string;
  kind: string;
  project_code: string;
  target_key: string;
  purpose: string;
  completion_criteria: string;
  evidence_seqs: number[];
  rationale: string;
  state: RequestState;
  attached_to: string | null;
  session_id: string | null;
  spawn_id: string | null;
  launch_deadline_at: number | null;
  outcome_summary: string | null;
  outcome_refs: string[];
  human_note: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
}

/** spawn 照合の寿命 (pending-delegation-spawns の TTL と同じ)。 */
export const LAUNCH_CONFIRM_WINDOW_MS = 5 * 60 * 1000;
export const TEXT_LIMIT = 4_000;
export const SUMMARY_LIMIT = 2_000;

/** 払い出し前後で、同じ対象の新しい依頼を吸収する状態。 */
export const OPEN_STATES: readonly RequestState[] = [
  "waiting_human", "queued", "launching", "launch_unknown", "dispatched",
];

/** 同時依頼数の上限に数える状態。 */
export const ACTIVE_STATES: readonly RequestState[] = [
  "queued", "launching", "launch_unknown", "dispatched",
];

const KIND_RE = /^[a-z][a-z0-9_-]{1,40}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export class ManagementInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new ManagementInputError(code, message);
}

export function requireText(value: unknown, field: string, limit = TEXT_LIMIT): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid_input", `${field} は必須です`);
  const text = value.trim();
  if (text.length > limit) fail("invalid_input", `${field} は ${limit} 文字以内です`);
  return text;
}

export function optionalText(value: unknown, field: string, limit = TEXT_LIMIT): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, field, limit);
}

export function requireKey(value: unknown, field: string): string {
  const text = requireText(value, field, 200);
  if (!KEY_RE.test(text)) fail("invalid_input", `${field} の形式が不正です`);
  return text;
}

export function optionalKey(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireKey(value, field);
}

export function requireKind(value: unknown, field = "kind"): string {
  const text = requireText(value, field, 41);
  if (!KIND_RE.test(text)) fail("invalid_input", `${field} は英小文字・数字・_- で指定します`);
  return text;
}

export function requireProject(value: unknown): string {
  const text = requireText(value, "project_code", 64);
  if (!PROJECT_RE.test(text)) fail("invalid_input", "project_code の形式が不正です");
  return text;
}

export function requireSource(value: unknown): string {
  const text = requireText(value, "source", 32);
  if (!SOURCE_RE.test(text)) fail("invalid_input", "source は英小文字で指定します");
  return text;
}

export function requireOrigin(value: unknown): EventOrigin {
  if (value === "human" || value === "ai" || value === "system") return value;
  return fail("invalid_input", "origin は human / ai / system のいずれかです");
}

export function requireVerdict(value: unknown): Exclude<DecisionVerdict, "request"> {
  if (value === "wait" || value === "skip" || value === "investigate" || value === "attach") return value;
  return fail("invalid_input", "verdict は wait / skip / investigate / attach のいずれかです");
}

export function requireSeqs(value: unknown): number[] {
  if (!Array.isArray(value)) fail("invalid_input", "evidence_seqs は配列です");
  const seqs = [...new Set(value)].map((v) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) fail("invalid_input", "evidence_seqs は正の整数です");
    return v;
  });
  if (seqs.length === 0) fail("invalid_input", "evidence_seqs が空です");
  if (seqs.length > 200) fail("invalid_input", "evidence_seqs は 200 件までです");
  return seqs.sort((a, b) => a - b);
}

export function requireKindList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) fail("invalid_input", `${field} は配列です`);
  const list = [...new Set(value.map((v) => requireKind(v, field)))];
  if (!allowEmpty && list.length === 0) fail("invalid_input", `${field} が空です`);
  return list;
}

export function requireProjectList(value: unknown): string[] {
  if (!Array.isArray(value)) fail("invalid_input", "project_codes は配列です");
  const list = [...new Set(value.map(requireProject))];
  if (list.length === 0) fail("invalid_input", "project_codes が空です");
  return list;
}

export function requireStringList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) fail("invalid_input", `${field} は ${max} 件までの配列です`);
  return value.map((v) => requireText(v, field, 500));
}

export function boundedInt(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail("invalid_input", `${field} は ${min}〜${max} の整数です`);
  }
  return value;
}

/** 根拠が AI 由来だけなら、AI の出力を新しい依頼として取り込むループになる (CC-MGMT-INV-06)。 */
export function isAiOnlyEvidence(events: readonly Pick<ManagementEvent, "origin">[]): boolean {
  return events.length > 0 && events.every((e) => e.origin === "ai");
}

export type IntakeVerdict =
  | { kind: "reject"; code: string; message: string }
  | { kind: "attach"; parent: ManagementRequest }
  | { kind: "accept"; state: "queued" | "waiting_human" };

export interface IntakeInput {
  mission: Mission;
  kind: string;
  project_code: string;
  evidence: readonly ManagementEvent[];
  evidenceSeqs: readonly number[];
  sameTargetOpen: ManagementRequest | null;
  activeCount: number;
  todayCount: number;
}

/** 受付判断 (CC-MGMT-04 の 1, 2, 4, 5, 6)。冪等照合は呼び出し側で先に行う。 */
export function decideIntake(input: IntakeInput): IntakeVerdict {
  const { mission } = input;
  if (mission.status !== "active") return reject("mission_stopped", "任務は停止中です");
  if (!mission.allowed_kinds.includes(input.kind) && !mission.human_gate_kinds.includes(input.kind)) {
    return reject("kind_not_allowed", `依頼種別 ${input.kind} は任務で許可されていません`);
  }
  if (!mission.project_codes.includes(input.project_code)) {
    return reject("project_out_of_scope", `${input.project_code} は任務の対象外です`);
  }
  if (input.evidence.length !== input.evidenceSeqs.length) {
    return reject("evidence_not_visible", "根拠に任務から見えないイベントが含まれています");
  }
  if (isAiOnlyEvidence(input.evidence)) {
    return reject("evidence_ai_only", "根拠が AI 由来のイベントだけです");
  }
  if (input.sameTargetOpen) return { kind: "attach", parent: input.sameTargetOpen };
  if (input.activeCount >= mission.max_open_requests) {
    return reject("limit_open_requests", "同時依頼数の上限に達しています");
  }
  if (input.todayCount >= mission.daily_request_limit) {
    return reject("limit_daily", "本日の依頼数の上限に達しています");
  }
  return { kind: "accept", state: mission.human_gate_kinds.includes(input.kind) ? "waiting_human" : "queued" };
}

function reject(code: string, message: string): IntakeVerdict {
  return { kind: "reject", code, message };
}

/** 処理済み位置を進められるか (CC-MGMT-INV-04)。未判断の seq を返す。 */
export function uncoveredSeqs(pending: readonly number[], covered: ReadonlySet<number>): number[] {
  return pending.filter((seq) => !covered.has(seq));
}

export type HumanAction = "approve" | "reject" | "accept" | "effect_confirmed" | "effect_not_met";

export function isHumanAction(value: unknown): value is HumanAction {
  return value === "approve" || value === "reject" || value === "accept"
    || value === "effect_confirmed" || value === "effect_not_met";
}

/** 人間の管理面からの遷移 (CC-MGMT-05 / INV-07)。許されない組合せは null。 */
export function humanTransition(
  state: RequestState,
  action: HumanAction,
  requiresEffectCheck: boolean,
): RequestState | null {
  switch (action) {
    case "approve":
      return state === "waiting_human" ? "queued" : null;
    case "reject":
      return state === "waiting_human" ? "rejected" : null;
    case "accept":
      return state === "outcome_recorded" || state === "execution_finished" ? "accepted" : null;
    case "effect_confirmed":
    case "effect_not_met":
      return state === "accepted" && requiresEffectCheck ? action : null;
  }
}

/** 担当セッションが成果を記録できる状態。 */
export function canRecordOutcome(state: RequestState): boolean {
  return state === "dispatched" || state === "execution_finished" || state === "outcome_recorded";
}

/** JST の日付境界 (日次上限の数え始め)。 */
export function startOfJstDay(now: number): number {
  const offset = 9 * 60 * 60 * 1000;
  return Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
}
