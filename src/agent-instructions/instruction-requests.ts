/**
 * 指令ブリッジの要求の形 (spec/feature/agent-instructions-bridge.md §口)。
 * 本文は固定スキーマ (strict)。 未知の項目・型違い・文字数 / バイト数超過は全部 400 にし、
 * message には直し方を書く (CC-INST-INV-01)。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 要求の検証
 */

import { z } from "zod";
import {
  INSTRUCTION_AGENTS,
  INSTRUCTION_LIMITS,
  INSTRUCTION_STATUSES,
  INSTRUCTION_TYPES,
  utf8Bytes,
  type FinalStatus,
  type InstructionAgent,
  type InstructionStatus,
  type InstructionType,
} from "./instruction-policy.js";

export interface RequestError {
  code: string;
  message: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: RequestError };

const jsonObject = (label: string, maxBytes: number) => z.record(z.unknown()).refine(
  (value) => utf8Bytes(JSON.stringify(value)) <= maxBytes,
  { message: `${label} は JSON にして ${maxBytes} バイト以内にしてください` },
);

const text = (label: string, max: number) => z.string({ invalid_type_error: `${label} は文字列で送ってください`, required_error: `${label} は必須です` })
  .trim()
  .min(1, `${label} を 1 文字以上入れてください`)
  .max(max, `${label} は ${max} 文字以内にしてください`);

const agent = z.enum(INSTRUCTION_AGENTS, { errorMap: () => ({ message: `agent は ${INSTRUCTION_AGENTS.join(" / ")} のどれかにしてください` }) });

const RegisterSchema = z.object({
  agent,
  type: z.enum(INSTRUCTION_TYPES, { errorMap: () => ({ message: `type は ${INSTRUCTION_TYPES.join(" / ")} のどれかにしてください (それ以外の type は使えません)` }) }),
  title: text("title", INSTRUCTION_LIMITS.titleChars),
  body: text("body", INSTRUCTION_LIMITS.bodyChars),
  params: jsonObject("params", INSTRUCTION_LIMITS.paramsBytes).optional(),
}).strict();

const AckSchema = z.object({ agent }).strict();

const ResultSchema = z.object({
  agent,
  status: z.enum(["done", "failed"], { errorMap: () => ({ message: "status は done か failed にしてください" }) }),
  summary: text("summary", INSTRUCTION_LIMITS.requestSummaryChars),
  detail: jsonObject("detail", INSTRUCTION_LIMITS.detailBytes).optional(),
}).strict();

function describe(error: z.ZodError): RequestError {
  const issue = error.issues[0];
  if (!issue) return { code: "invalid_body", message: "本文が決められた形ではありません" };
  if (issue.code === "unrecognized_keys") {
    return { code: "unknown_field", message: `決められていない項目 ${issue.keys.join(", ")} を外してください` };
  }
  const field = issue.path.join(".");
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return { code: "missing_field", message: `${field} は必須です` };
  }
  if (issue.code === "invalid_type" && issue.path.length === 0) {
    return { code: "invalid_body", message: "本文は JSON のオブジェクトで送ってください" };
  }
  const code = field === "type" ? "unsupported_type" : "invalid_field";
  return { code, message: field ? `${field}: ${issue.message}` : issue.message };
}

function parseWith<T>(schema: z.ZodType<T>, body: unknown): Parsed<T> {
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: describe(parsed.error) };
}

export interface RegisterRequest {
  agent: InstructionAgent;
  type: InstructionType;
  title: string;
  body: string;
  params: Record<string, unknown>;
}

export function parseRegister(body: unknown): Parsed<RegisterRequest> {
  const parsed = parseWith(RegisterSchema, body);
  return parsed.ok ? { ok: true, value: { ...parsed.value, params: parsed.value.params ?? {} } } : parsed;
}

export function parseAck(body: unknown): Parsed<{ agent: InstructionAgent }> {
  return parseWith(AckSchema, body);
}

export interface ResultRequest {
  agent: InstructionAgent;
  status: FinalStatus;
  summary: string;
  detail?: Record<string, unknown> | undefined;
}

export function parseResult(body: unknown): Parsed<ResultRequest> {
  return parseWith(ResultSchema, body);
}

export interface PollQuery {
  agent: InstructionAgent;
  status: InstructionStatus;
  limit: number;
}

/** GET の query。 agent 必須、 status 省略時 pending、 limit は 1〜20 (省略時 10)。 */
export function parsePollQuery(query: (name: string) => string | undefined): Parsed<PollQuery> {
  const rawAgent = query("agent");
  if (!rawAgent) return { ok: false, error: { code: "missing_field", message: "agent を query に付けてください (例: ?agent=muse)" } };
  if (!(INSTRUCTION_AGENTS as readonly string[]).includes(rawAgent)) {
    return { ok: false, error: { code: "invalid_field", message: `agent は ${INSTRUCTION_AGENTS.join(" / ")} のどれかにしてください` } };
  }
  const rawStatus = query("status") ?? "pending";
  if (!(INSTRUCTION_STATUSES as readonly string[]).includes(rawStatus)) {
    return { ok: false, error: { code: "invalid_field", message: `status は ${INSTRUCTION_STATUSES.join(" / ")} のどれかにしてください (省略時は pending)` } };
  }
  const rawLimit = query("limit");
  const { pollMin, pollMax, pollDefault } = INSTRUCTION_LIMITS;
  const limit = rawLimit === undefined ? pollDefault : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  if (!Number.isInteger(limit) || limit < pollMin || limit > pollMax) {
    return { ok: false, error: { code: "invalid_field", message: `limit は ${pollMin}〜${pollMax} の整数にしてください (省略時は ${pollDefault})` } };
  }
  return { ok: true, value: { agent: rawAgent as InstructionAgent, status: rawStatus as InstructionStatus, limit } };
}

export interface HistoryQuery {
  agent?: InstructionAgent | undefined;
  status?: InstructionStatus | undefined;
  limit: number;
}

/**
 * 一覧 (GET /v1/instructions/history) の query。 agent / status は省略で全部、 limit は 1〜100 (省略時 50)。
 * Muse 向けの poll (agent 必須・status 省略時 pending) とは別の口なので、 poll の意味は変えない。
 */
export function parseHistoryQuery(query: (name: string) => string | undefined): Parsed<HistoryQuery> {
  const rawAgent = query("agent");
  if (rawAgent !== undefined && rawAgent !== "" && !(INSTRUCTION_AGENTS as readonly string[]).includes(rawAgent)) {
    return { ok: false, error: { code: "invalid_field", message: `agent は ${INSTRUCTION_AGENTS.join(" / ")} のどれかにしてください (省略時は全部)` } };
  }
  const rawStatus = query("status");
  if (rawStatus !== undefined && rawStatus !== "" && !(INSTRUCTION_STATUSES as readonly string[]).includes(rawStatus)) {
    return { ok: false, error: { code: "invalid_field", message: `status は ${INSTRUCTION_STATUSES.join(" / ")} のどれかにしてください (省略時は全部)` } };
  }
  const rawLimit = query("limit");
  const { historyMin, historyMax, historyDefault } = INSTRUCTION_LIMITS;
  const limit = rawLimit === undefined || rawLimit === "" ? historyDefault : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  if (!Number.isInteger(limit) || limit < historyMin || limit > historyMax) {
    return { ok: false, error: { code: "invalid_field", message: `limit は ${historyMin}〜${historyMax} の整数にしてください (省略時は ${historyDefault})` } };
  }
  return {
    ok: true,
    value: {
      agent: rawAgent ? rawAgent as InstructionAgent : undefined,
      status: rawStatus ? rawStatus as InstructionStatus : undefined,
      limit,
    },
  };
}
