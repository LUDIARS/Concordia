/**
 * 定時ジョブを外部エージェント (dots / Muse) の指令へ回すときの業務判断 (純関数)。
 * I/O を持たない。 発火の分岐は agent-dispatch.ts、 期限切れの戻しは agent-fallback.ts が行う。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 宛先・dedupe_key・期限・params の上限
 */

import { INSTRUCTION_AGENTS, INSTRUCTION_LIMITS, type InstructionAgent } from "../agent-instructions/instruction-policy.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:70a53b0c */
import augurContract_e1aef40a from './agent-jobs/report-only-route.contract.js'; /* augur-inject:contract-predicate:feaaca61 */

/** cron 由来の指令の dedupe_key の接頭辞。 期限切れの戻しはこの接頭辞の指令だけを対象にする。 */
export const CRON_DEDUPE_PREFIX = "cron:";

/** 受け取られない指令を Cc の委託へ戻すまでの既定 (分)。 */
export const DEFAULT_AGENT_FALLBACK_MINUTES = 180;

/** 期限切れで閉じるときの要約 (設計書の文言どおり)。 */
export const FALLBACK_CLOSE_SUMMARY = "期限内に受け取られなかったため Cc の委託へ戻した";

/** Cc が閉じた指令の detail。 結果の引き取りはこの印の付いた finished を反映しない。 */
export const FALLBACK_CLOSE_DETAIL = { closed_by: "concordia", fallback: "delegation" } as const;
export const REPORT_ONLY_CLOSE_SUMMARY = "期限内に受け取られなかったため指令を終了した";

/** Expiry must not repeat HQ ingestion or turn a proposal into a work delegation. */
export function usesReportOnlyRoute(jobName: string): boolean {
  return jobName === "quaestor-mail-sweep" || jobName === "kaizen-daily";
}
// @ts-expect-error augur-inject
usesReportOnlyRoute = contract(usesReportOnlyRoute, { ...augurContract_e1aef40a, contractId: 'cron-mail-kaizen-C-43', mode: 'observe', sample: 1, where: 'src/scheduler/agent-dispatch-policy.ts:24', rule: 'contract-wrap', id: 'e1aef40a' }); /* augur-inject:contract-wrap:e1aef40a */

export type AgentChoice = { ok: true; agent: InstructionAgent | null } | { ok: false; error: string };

/** 設定値 / API 入力の宛先を解釈する。 "" / null は従来の委託 (null)。 */
export function parseAgentChoice(raw: unknown): AgentChoice {
  if (raw === null || raw === undefined || raw === "") return { ok: true, agent: null };
  if (typeof raw !== "string") return { ok: false, error: "agent must be a string" };
  const value = raw.trim();
  if (value === "") return { ok: true, agent: null };
  return (INSTRUCTION_AGENTS as readonly string[]).includes(value)
    ? { ok: true, agent: value as InstructionAgent }
    : { ok: false, error: `agent must be one of "", ${INSTRUCTION_AGENTS.join(", ")}` };
}

const JST_MINUTE = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** JST の分精度 (`2026-11-24T07:10`)。 */
export function jstMinute(at: Date): string {
  const parts = Object.fromEntries(JST_MINUTE.formatToParts(at).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** `cron:<jobName>:<target or "-">:<発火時刻 (分単位、JST)>`。 同じ発火の再実行は同じキーになる。 */
export function buildDedupeKey(jobName: string, targetKey: string, firedAt: Date): string {
  return `${CRON_DEDUPE_PREFIX}${jobName}:${targetKey || "-"}:${jstMinute(firedAt)}`;
}

/** これより前に登録されて受け取られていない指令は戻す。 */
export function fallbackCutoff(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

/** cron 由来の指令の params のうち、 Cc が引き取り・戻しに使う部分。 */
export interface CronInstructionParams {
  job: string;
  target: string;
  callName: string | null;
  args: Record<string, unknown>;
  options: Record<string, unknown> | null;
  dedupeKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** cron 由来 (dedupe_key が cron: で始まる) の params なら解釈する。 それ以外は null。 */
export function parseCronInstructionParams(raw: unknown): CronInstructionParams | null {
  if (!isRecord(raw)) return null;
  const { job, dedupe_key: dedupeKey } = raw;
  if (typeof job !== "string" || job === "" || typeof dedupeKey !== "string" || !dedupeKey.startsWith(CRON_DEDUPE_PREFIX)) return null;
  return {
    job,
    target: typeof raw.target === "string" ? raw.target : "",
    callName: typeof raw.call_name === "string" && raw.call_name !== "" ? raw.call_name : null,
    args: isRecord(raw.args) ? raw.args : {},
    options: isRecord(raw.options) ? raw.options : null,
    dedupeKey,
  };
}

/** Cc が期限切れで閉じた指令の detail か。 */
export function isClosedByConcordia(detail: unknown): boolean {
  return isRecord(detail) && detail.closed_by === FALLBACK_CLOSE_DETAIL.closed_by;
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
  /\b(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/gu,
  /\bBearer\s+\S+/giu,
  /(?<=[?&](?:token|key|secret|sig|signature|access_token)=)[^&\s]+/giu,
  /(?<=https?:\/\/)[^/\s:@]+:[^/\s@]+(?=@)/giu,
];

/** 文字列からメールアドレス・トークンらしい値・URL の資格情報を伏せる (builder の取りこぼしの保険)。 */
export function scrubText(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), text);
}

/** 値の中の文字列を再帰的に scrubText する。 */
export function scrubValue<T>(value: T): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValue(v)])) as T;
  }
  return value;
}

/**
 * params を上限 (8000 バイト、CC-INST-INV-01) に収める。 data の配列の末尾 (builder が重要度の低い順に並べた最後)
 * から 1 件ずつ落とし、 落とした件数を data.truncated に入れる。 配列を落としきっても収まらなければ throw。
 */
export function fitParams(
  envelope: Record<string, unknown>,
  data: Record<string, unknown>,
  limitBytes: number = INSTRUCTION_LIMITS.paramsBytes,
): Record<string, unknown> {
  const working: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(working)) if (Array.isArray(value)) working[key] = [...value];
  let truncated = 0;
  const assemble = () => ({ ...envelope, data: truncated > 0 ? { ...working, truncated } : working });
  while (utf8Bytes(assemble()) > limitBytes) {
    const longest = Object.entries(working)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .sort((a, b) => utf8Bytes(b[1]) - utf8Bytes(a[1]))[0];
    if (!longest) throw new Error(`instruction params exceed ${limitBytes} bytes even after truncation`);
    longest[1].pop();
    truncated += 1;
  }
  return assemble();
}
