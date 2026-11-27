/**
 * 外部エージェント宛て指令の業務判断 (spec/feature/agent-instructions-bridge.md)。
 * I/O を持たない純関数だけを置く。 状態の所有者は agent_instructions テーブル (Cc)。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 状態遷移と冪等
 */

import { randomBytes } from "node:crypto";

/**
 * 宛先エージェントの許可リスト。 宛先は AI の種類の識別子を兼ね、 poll / ack / result は `agent` で名乗る。
 * 公開経由の鍵は全宛先で 1 つを共用する (CC-INST-INV-06)。 増やすときは指示書の改訂として扱う (CC-INST-INV-02)。
 * 2026-11-23 neco 指示「dotsも同じ路線でやる。AIのタイプ認識用にtypeか何かのパラメータを用意する」で dots を追加。
 */
export const INSTRUCTION_AGENTS = ["muse", "dots"] as const;
export type InstructionAgent = (typeof INSTRUCTION_AGENTS)[number];

/** 指令 type の許可リスト (指示書 §3.3)。 */
/**
 * card_triage は Cc v5 の管制カードの捌き (dots 宛て、spec/feature/control-cards.md)。
 * 2026-11-24 neco 指示「カードの捌きやリマインドを担当して欲しい」で追加 (CC-INST-INV-02 の改訂)。
 */
export const INSTRUCTION_TYPES = ["notify_only", "run_task", "status_query", "playtest", "card_triage"] as const;
export type InstructionType = (typeof INSTRUCTION_TYPES)[number];

export const INSTRUCTION_STATUSES = ["pending", "acked", "done", "failed"] as const;
export type InstructionStatus = (typeof INSTRUCTION_STATUSES)[number];
export type FinalStatus = Extract<InstructionStatus, "done" | "failed">;

export const INSTRUCTION_LIMITS = {
  titleChars: 200,
  bodyChars: 4000,
  paramsBytes: 8000,
  requestSummaryChars: 400,
  storedSummaryChars: 2000,
  detailBytes: 16000,
  pollDefault: 10,
  pollMin: 1,
  pollMax: 20,
  historyDefault: 50,
  historyMin: 1,
  historyMax: 100,
} as const;

/** acked のまま result が来ないとき、 pending に戻すまでの時間 (指示書 §3.4)。 */
export const ACK_REDELIVERY_MS = 30 * 60 * 1000;
/** done / failed の保持日数 (session_events と同じ 90 日)。 */
export const FINISHED_RETENTION_DAYS = 90;

/** `inst:<agent>:<YYYYMMDDTHHMMSSZ>:<6 桁 hex>`。 */
export const INSTRUCTION_ID_PATTERN = /^inst:[a-z][a-z0-9_-]{0,31}:\d{8}T\d{6}Z:[0-9a-f]{6}$/;

/** 秒精度の ISO 8601 UTC (`2026-11-21T00:00:00Z`)。 */
export function isoSeconds(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newInstructionId(agent: InstructionAgent, at: Date, random: () => string = () => randomBytes(3).toString("hex")): string {
  const stamp = isoSeconds(at).replace(/[-:]/g, "");
  return `inst:${agent}:${stamp}:${random()}`;
}

/**
 * 重複判定キー dedupe_key を確定する (CC-INST-INV-11)。 登録者が params に文字列で入れていればそのまま使い、
 * 無ければ Cc がワンタイムトークンとして発行する。 受け手 (Muse など) は同じキーの再配信を二重に実行しない。
 */
export function withDedupeKey(
  params: Record<string, unknown>, issue: () => string = () => `dk_${randomBytes(16).toString("hex")}`,
): { params: Record<string, unknown>; dedupeKey: string } {
  const given = params.dedupe_key;
  if (typeof given === "string" && given.trim() !== "") return { params, dedupeKey: given };
  const dedupeKey = issue();
  return { params: { ...params, dedupe_key: dedupeKey }, dedupeKey };
}

/** UTF-8 のバイト数。 */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** キー順に依存しない JSON。 同一結果の再送判定に使う。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 保存する要約。 2000 文字で切り詰める (コードポイント単位)。 */
export function storedSummary(summary: string): string {
  const chars = Array.from(summary);
  return chars.length > INSTRUCTION_LIMITS.storedSummaryChars
    ? chars.slice(0, INSTRUCTION_LIMITS.storedSummaryChars).join("")
    : summary;
}

export type AckDecision = "accept" | "duplicate" | "conflict";

/** ack の判定 (CC-INST-INV-03)。 */
export function decideAck(status: InstructionStatus): AckDecision {
  if (status === "pending") return "accept";
  if (status === "acked") return "duplicate";
  return "conflict";
}

export interface StoredResult {
  status: InstructionStatus;
  resultSummary: string | null;
  resultDetail: string | null;
}

export interface IncomingResult {
  status: FinalStatus;
  /** storedSummary 済みの要約。 */
  summary: string;
  /** canonicalJson 済みの詳細。 省略時は null。 */
  detail: string | null;
}

export type ResultDecision = "accept" | "duplicate" | "conflict";

/** result の判定 (CC-INST-INV-04)。 終端は同一結果だけを重複として受け、 違えば衝突。 */
export function decideResult(current: StoredResult, incoming: IncomingResult): ResultDecision {
  if (current.status === "pending" || current.status === "acked") return "accept";
  const same = current.status === incoming.status
    && current.resultSummary === incoming.summary
    && (current.resultDetail ?? null) === incoming.detail;
  return same ? "duplicate" : "conflict";
}

/** acked のまま再配信に戻す境界時刻 (これより前に acked されたもの)。 */
export function redeliveryCutoff(now: Date): string {
  return isoSeconds(new Date(now.getTime() - ACK_REDELIVERY_MS));
}

/** 終端の指令を刈る境界時刻 (これより前に終わったもの)。 */
export function retentionCutoff(now: Date): string {
  return isoSeconds(new Date(now.getTime() - FINISHED_RETENTION_DAYS * 86_400_000));
}
