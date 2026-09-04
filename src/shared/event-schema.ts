import { z } from "zod";
import type { ConcordiaEvent } from "../events.js";
import { TEAM_CARD_EVENT_KINDS } from "./team-cards.js";
import { InjectionProvenanceSchema } from "./injection-provenance-schema.js";

export const WS_EVENT_VERSION = 1;

export const CONCORDIA_EVENT_TYPES = [
  "session.started",
  "session.lost",
  "session.ended",
  "session.event",
  "session.task_changed",
  "chat.posted",
  "task.enqueued",
  "operational.claim.opened",
  "operational.claim.released",
  "skill.snapshot",
  "report.generated",
  "rule.changed",
  "delegation.templates_changed",
  "process.started",
  "process.log",
  "process.exited",
  "stat.collected",
  "pr.changed",
  "error.reported",
  "session.inject",
  "session.stall_nudged",
  "delegation.mirror",
  "delegation.run_changed",
  "taskflow.user_decision",
  "taskflow.completion_detected",
  "taskflow.residual_checked",
  "taskflow.continue_requested",
  "director.plan_submitted",
  "team.created",
  "team.changed",
  "staff.access_changed",
  "team.card_requested",
  "vibes.ok",
  "transcript.frame",
  "session.permission_request",
  "question.posted",
  "question.answered",
  "question.resolved",
  "session.message",
  "session.message.summary",
  "inquiry.resolved",
  "federation.site.connected",
  "federation.site.disconnected",
  "ping",
] as const satisfies readonly ConcordiaEvent["type"][];

type EventType = (typeof CONCORDIA_EVENT_TYPES)[number];
type MissingEventType = Exclude<ConcordiaEvent["type"], EventType>;
const _eventAllowlistCoversAllTypes: MissingEventType extends never ? true : never = true;

const eventTypeSet = new Set<string>(CONCORDIA_EVENT_TYPES);

export function isConcordiaEventType(type: unknown): type is EventType {
  return typeof type === "string" && eventTypeSet.has(type);
}

const nullableString = z.string().nullable();
const optionalPlatform = z.enum(["discord", "slack"]).optional();
const questionOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string(),
    description: z.string().optional(),
  }).passthrough(),
]);

const eventSchemas = {
  "session.started": z.object({
    type: z.literal("session.started"),
    session_id: z.string(),
    provider: z.string(),
    repo_path: z.string(),
    branch: nullableString,
    ts: z.number(),
  }).passthrough(),
  "session.lost": z.object({
    type: z.literal("session.lost"),
    session_id: z.string(),
    ts: z.number(),
  }).passthrough(),
  "session.ended": z.object({
    type: z.literal("session.ended"),
    session_id: z.string(),
    ts: z.number(),
  }).passthrough(),
  "session.event": z.object({
    type: z.literal("session.event"),
    session_id: z.string(),
    kind: z.string(),
    ts: z.number(),
  }).passthrough(),
  "session.task_changed": z.object({
    type: z.literal("session.task_changed"),
    session_id: z.string(),
    previous_task: nullableString,
    current_task: nullableString,
    ts: z.number(),
  }).passthrough(),
  "chat.posted": z.object({
    type: z.literal("chat.posted"),
    message_id: z.number(),
    channel: z.string(),
    author_label: z.string(),
    ts: z.number(),
    is_actionable: z.boolean(),
    scope: z.enum(["world", "local"]).optional(),
    session_id: nullableString.optional(),
  }).passthrough(),
  "task.enqueued": z.object({
    type: z.literal("task.enqueued"),
    session_id: z.string(),
    task_id: z.number(),
    kind: z.string(),
    ts: z.number(),
  }).passthrough(),
  "operational.claim.opened": z.object({
    type: z.literal("operational.claim.opened"),
    target_session_id: z.string(),
    claim_kind: z.string(),
    claim_id: z.number(),
    resource: z.string(),
    branch: nullableString,
    note: z.string(),
    conflict_session_ids: z.array(z.string()),
    started_at: z.number(),
    ts: z.number(),
  }).passthrough(),
  "operational.claim.released": z.object({
    type: z.literal("operational.claim.released"),
    target_session_id: z.string(),
    claim_kind: z.string(),
    claim_id: z.number(),
    resource: z.string(),
    branch: nullableString,
    note: z.string(),
    started_at: z.number(),
    ts: z.number(),
  }).passthrough(),
  "skill.snapshot": z.object({
    type: z.literal("skill.snapshot"),
    skill_name: z.string(),
    repo_path: z.string(),
    poison_score: z.number(),
    growth_score: z.number(),
    ts: z.number(),
  }).passthrough(),
  "report.generated": z.object({
    type: z.literal("report.generated"),
    session_id: z.string(),
    ts: z.number(),
  }).passthrough(),
  "rule.changed": z.object({
    type: z.literal("rule.changed"),
    rule_id: nullableString,
    action: z.enum(["add", "remove", "toggle", "fire", "skip", "error"]),
    ts: z.number(),
  }).passthrough(),
  "delegation.templates_changed": z.object({
    type: z.literal("delegation.templates_changed"),
    action: z.enum(["create", "import", "patch", "delete"]),
    template_id: nullableString,
    call_name: nullableString,
    ts: z.number(),
  }).passthrough(),
  "delegation.mirror": z.object({
    type: z.literal("delegation.mirror"),
    target_session_id: z.string(),
    run_id: z.string(),
    parent_session_id: nullableString.optional(),
    child_session_id: nullableString,
    link_side: z.enum(["parent", "child"]).optional(),
    text: z.string(),
    ts: z.number(),
  }).passthrough(),
  "delegation.run_changed": z.object({
    type: z.literal("delegation.run_changed"),
    parent_session_id: nullableString,
    run_id: z.string(),
    status: z.string(),
    ts: z.number(),
  }).passthrough(),
  "taskflow.user_decision": z.object({ type: z.literal("taskflow.user_decision"), kind: z.enum(["confirm-queued", "no-tasks", "pr-decision", "impl-unlock", "question"]), target_session_id: z.string(), text: z.string(), mention_user_id: nullableString, ts: z.number() }).passthrough(),
  "taskflow.completion_detected": z.object({ type: z.literal("taskflow.completion_detected"), session_id: z.string(), pr_number: z.number().nullable(), outcome: z.string(), decision_id: z.number().optional(), ts: z.number() }).passthrough(),
  "taskflow.residual_checked": z.object({ type: z.literal("taskflow.residual_checked"), session_id: z.string(), outcome: z.enum(["next-task", "decompose", "none"]), pending_count: z.number(), ts: z.number() }).passthrough(),
  "taskflow.continue_requested": z.object({ type: z.literal("taskflow.continue_requested"), target_session_id: z.string(), text: z.string(), ts: z.number() }).passthrough(),
  "director.plan_submitted": z.object({ type: z.literal("director.plan_submitted"), target_session_id: z.string(), case_id: z.string(), version: z.number(), markdown: z.string(), ts: z.number() }).passthrough(),
  "team.created": z.object({ type: z.literal("team.created"), event_id: z.string(), team_id: z.string(), name: z.string(), slug: z.string(), ts: z.number() }).passthrough(),
  "team.changed": z.object({ type: z.literal("team.changed"), event_id: z.string(), team_id: z.string(), fields: z.array(z.string()), ts: z.number() }).passthrough(),
  "staff.access_changed": z.object({ type: z.literal("staff.access_changed"), platform: z.enum(["discord", "slack"]), ts: z.number() }).passthrough(),
  "team.card_requested": z.object({ type: z.literal("team.card_requested"), team_id: z.string(), kind: z.enum(TEAM_CARD_EVENT_KINDS), title: z.string(), body: z.string(), ts: z.number() }).passthrough(),
  "vibes.ok": z.object({ type: z.literal("vibes.ok"), session_id: z.string(), source: z.string(), ts: z.number() }).passthrough(),
  "process.started": z.object({
    type: z.literal("process.started"),
    process_name: z.string(),
    pid: z.number(),
    cwd: z.string(),
    command: z.string(),
    ts: z.number(),
  }).passthrough(),
  "process.log": z.object({
    type: z.literal("process.log"),
    process_name: z.string(),
    stream: z.enum(["stdout", "stderr", "event"]),
    line: z.string(),
    level: z.enum(["error", "warn", "info"]).optional(),
    ts: z.number(),
  }).passthrough(),
  "process.exited": z.object({
    type: z.literal("process.exited"),
    process_name: z.string(),
    exit_code: z.number().nullable(),
    signal: nullableString,
    ts: z.number(),
  }).passthrough(),
  "stat.collected": z.object({
    type: z.literal("stat.collected"),
    session_id: z.string(),
    stat_id: z.number(),
    ts: z.number(),
  }).passthrough(),
  "pr.changed": z.object({
    type: z.literal("pr.changed"),
    reason: z.enum(["ingest", "reconcile", "full-sync"]),
    ts: z.number(),
  }).passthrough(),
  "error.reported": z.object({
    type: z.literal("error.reported"),
    source: z.string(),
    message: z.string(),
    detail: z.record(z.unknown()).optional(),
    ts: z.number(),
  }).passthrough(),
  "session.inject": z.object({
    type: z.literal("session.inject"),
    target_session_id: z.string(),
    text: z.string(),
    source: nullableString,
    author_label: nullableString.optional(),
    provenance: InjectionProvenanceSchema.optional(),
    ts: z.number(),
  }).passthrough(),
  "session.stall_nudged": z.object({
    type: z.literal("session.stall_nudged"),
    target_session_id: z.string(),
    idle_sec: z.number(),
    ts: z.number(),
  }).passthrough(),
  "transcript.frame": z.object({
    type: z.literal("transcript.frame"),
    target_session_id: z.string(),
    seq: z.number(),
    kind: z.string(),
    payload: z.unknown(),
    ts: z.number(),
  }).passthrough(),
  "session.permission_request": z.object({
    type: z.literal("session.permission_request"),
    target_session_id: z.string(),
    request_id: z.string(),
    tool_name: z.string(),
    tool_input: z.unknown(),
    requester_platform: optionalPlatform,
    requester_user_id: z.string().optional(),
    ts: z.number(),
  }).passthrough(),
  "question.posted": z.object({
    type: z.literal("question.posted"),
    target_session_id: z.string(),
    question_id: z.number(),
    question: z.string(),
    options: z.array(questionOptionSchema),
    multi_select: z.boolean().optional(),
    parent_session_id: z.string().optional(),
    delegation_run_id: z.string().optional(),
    requester_platform: optionalPlatform,
    requester_user_id: z.string().optional(),
    ts: z.number(),
  }).passthrough(),
  "question.answered": z.object({
    type: z.literal("question.answered"),
    target_session_id: z.string(),
    question_id: z.number(),
    answer_index: z.number(),
    answer_text: z.string(),
    ts: z.number(),
  }).passthrough(),
  "question.resolved": z.object({
    type: z.literal("question.resolved"),
    target_session_id: z.string(),
    question_id: z.number(),
    ts: z.number(),
  }).passthrough(),
  "session.message": z.object({
    type: z.literal("session.message"),
    target_session_id: z.string(),
    op: z.enum(["create", "update"]),
    message: z.object({
      id: z.number(),
      session_id: z.string(),
      ts: z.number(),
      edited_ts: z.number().nullable(),
      author_type: z.string(),
      author_label: z.string(),
      author_platform: nullableString,
      content: z.string(),
      embeds: z.array(z.unknown()).nullable(),
      components: z.array(z.unknown()).nullable(),
      attachments: z.array(z.unknown()).nullable(),
      reference_id: z.number().nullable(),
      metadata: z.record(z.unknown()).nullable(),
      dedupe_key: nullableString,
    }).passthrough(),
    ts: z.number(),
  }).passthrough(),
  "session.message.summary": z.object({
    type: z.literal("session.message.summary"),
    target_session_id: z.string(),
    latest_id: z.number(),
    ts: z.number(),
  }).passthrough(),
  "inquiry.resolved": z.object({
    type: z.literal("inquiry.resolved"),
    target_session_id: z.string(),
    category: z.string(),
    decision: z.enum(["proceed", "ask_human", "self_judge"]),
    supervisor_user_id: z.string().nullable(),
    ts: z.number(),
  }).passthrough(),
  "federation.site.connected": z.object({
    type: z.literal("federation.site.connected"),
    site_id: z.string(),
    ts: z.number(),
  }).passthrough(),
  "federation.site.disconnected": z.object({
    type: z.literal("federation.site.disconnected"),
    site_id: z.string(),
    ts: z.number(),
  }).passthrough(),
  ping: z.object({
    type: z.literal("ping"),
    ts: z.number(),
  }).passthrough(),
} satisfies Record<EventType, z.ZodTypeAny>;

const helloFrameSchema = z.object({
  v: z.literal(WS_EVENT_VERSION).optional().default(WS_EVENT_VERSION),
  type: z.literal("hello"),
  ts: z.number(),
  service: z.literal("concordia"),
  session_id: nullableString.optional(),
  registered: z.boolean().optional(),
}).passthrough();

export type WsHelloFrame = z.infer<typeof helloFrameSchema>;
export type WsConcordiaEventFrame = ConcordiaEvent & { v: typeof WS_EVENT_VERSION };
export type WsFrame = WsHelloFrame | WsConcordiaEventFrame;

export type WsFrameRejectReason =
  | "invalid_frame"
  | "unsupported_version"
  | "unknown_event"
  | "invalid_event";

export type ParseWsFrameResult =
  | { ok: true; frame: WsFrame }
  | { ok: false; reason: WsFrameRejectReason; type?: string; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function versionOf(frame: Record<string, unknown>): typeof WS_EVENT_VERSION | null {
  const version = frame.v ?? WS_EVENT_VERSION;
  return version === WS_EVENT_VERSION ? WS_EVENT_VERSION : null;
}

export function parseConcordiaEvent(input: unknown): { ok: true; event: ConcordiaEvent } | { ok: false; reason: WsFrameRejectReason; type?: string; detail?: string } {
  if (!isRecord(input) || typeof input.type !== "string") {
    return { ok: false, reason: "invalid_frame", detail: "missing string type" };
  }
  if (!isConcordiaEventType(input.type)) {
    return { ok: false, reason: "unknown_event", type: input.type };
  }

  const parsed = eventSchemas[input.type].safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_event",
      type: input.type,
      detail: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }
  const { v: _v, ...event } = parsed.data as Record<string, unknown>;
  return { ok: true, event: event as ConcordiaEvent };
}

export function parseWsFrame(input: unknown): ParseWsFrameResult {
  if (!isRecord(input) || typeof input.type !== "string") {
    return { ok: false, reason: "invalid_frame", detail: "missing string type" };
  }
  const version = versionOf(input);
  if (version === null) {
    return { ok: false, reason: "unsupported_version", type: input.type, detail: `v=${String(input.v)}` };
  }

  if (input.type === "hello") {
    const parsed = helloFrameSchema.safeParse({ ...input, v: version });
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid_frame",
        type: input.type,
        detail: parsed.error.issues.map((issue) => issue.message).join("; "),
      };
    }
    return { ok: true, frame: parsed.data };
  }

  const parsed = parseConcordiaEvent(input);
  if (!parsed.ok) return parsed;
  return { ok: true, frame: { ...parsed.event, v: version } as WsConcordiaEventFrame };
}

export function toWsEventFrame(event: ConcordiaEvent): WsConcordiaEventFrame {
  return { ...event, v: WS_EVENT_VERSION } as WsConcordiaEventFrame;
}

export function toWsHelloFrame(input: { ts: number; session_id?: string | null; registered?: boolean }): WsHelloFrame {
  return {
    ...input,
    v: WS_EVENT_VERSION,
    type: "hello",
    service: "concordia",
  };
}

export function eventFromWsFrame(frame: WsConcordiaEventFrame): ConcordiaEvent {
  const { v: _v, ...event } = frame;
  return event as ConcordiaEvent;
}
