/**
 * 外部エージェント宛て指令の use case (spec/feature/agent-instructions-bridge.md)。
 * 登録・ポーリング・ack・結果報告・状態確認・掃除。 入力の形は API 層で検証済みのものを受ける。
 * 判定は instruction-policy.ts、 保存は AgentInstructionStore に任せる。
 *
 * @implements spec/feature/agent-instructions-bridge.md — use case
 */

import type { AgentInstructionRow, AgentInstructionStore } from "../db/agent-instructions-repo.js";
import type { InstructionEvent } from "./instruction-events.js";
import {
  canonicalJson,
  decideAck,
  decideResult,
  isoSeconds,
  newInstructionId,
  redeliveryCutoff,
  retentionCutoff,
  storedSummary,
  type FinalStatus,
  type InstructionAgent,
  type InstructionStatus,
  type InstructionType,
} from "./instruction-policy.js";

export interface RegisterInput {
  agent: InstructionAgent;
  type: InstructionType;
  title: string;
  body: string;
  params: Record<string, unknown>;
}

export interface ResultInput {
  agent: InstructionAgent;
  status: FinalStatus;
  summary: string;
  detail?: Record<string, unknown> | undefined;
}

export interface DeliveredInstruction {
  id: string;
  type: string;
  title: string;
  body: string;
  params: unknown;
  createdAt: string;
}

export interface InstructionState {
  id: string;
  agent: string;
  type: string;
  title: string;
  status: InstructionStatus;
  createdAt: string;
  ackedAt: string | null;
  finishedAt: string | null;
  resultSummary: string | null;
}

/** 人が見る一覧の 1 行 (Web の「Muse 指令」)。 本文と回答の詳細も含む。 */
export interface InstructionRecord extends InstructionState {
  body: string;
  params: unknown;
  resultDetail: unknown;
}

export interface HistoryFilter {
  agent?: InstructionAgent | undefined;
  status?: InstructionStatus | undefined;
  limit: number;
}

export type AckOutcome =
  | { kind: "accepted" | "duplicate"; id: string; status: "acked"; ackedAt: string }
  | { kind: "conflict"; status: InstructionStatus }
  | { kind: "not_found" };

export type ResultOutcome =
  | { kind: "accepted" | "duplicate"; id: string; status: FinalStatus; finishedAt: string }
  | { kind: "conflict"; status: InstructionStatus }
  | { kind: "not_found" };

export interface InstructionServiceDeps {
  store: AgentInstructionStore;
  now?: () => Date;
  randomSuffix?: () => string;
  /** 出来事の受け手 (「muse-指令」チャンネル)。 後追い・best-effort で、 失敗しても遷移は失敗させない (CC-INST-INV-08)。 */
  events?: (event: InstructionEvent) => void;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function toState(row: AgentInstructionRow): InstructionState {
  return {
    id: row.id, agent: row.agent, type: row.type, title: row.title, status: row.status,
    createdAt: row.created_at, ackedAt: row.acked_at, finishedAt: row.finished_at, resultSummary: row.result_summary,
  };
}

export class InstructionService {
  private readonly now: () => Date;

  constructor(private readonly deps: InstructionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  register(input: RegisterInput): { id: string; status: "pending"; createdAt: string } {
    const at = this.now();
    const createdAt = isoSeconds(at);
    // 秒精度 + 24bit 乱数なので衝突はまず無いが、 起きたら引き直す (PK 違反で 500 にしない)。
    for (let attempt = 0; ; attempt++) {
      const id = newInstructionId(input.agent, at, this.deps.randomSuffix);
      if (this.deps.store.find(id)) {
        if (attempt >= 4) throw new Error("instruction id collision");
        continue;
      }
      this.deps.store.insert({
        id, agent: input.agent, type: input.type, title: input.title, body: input.body,
        params: JSON.stringify(input.params), created_at: createdAt,
      });
      this.emit({ kind: "registered", id, agent: input.agent, type: input.type, title: input.title, body: input.body, createdAt });
      return { id, status: "pending", createdAt };
    }
  }

  /** 古い順に返す。 返す前に、 30 分 result の無い acked を pending に戻す (CC-INST-INV-05)。 */
  poll(agent: InstructionAgent, status: InstructionStatus, limit: number): DeliveredInstruction[] {
    this.requeueStale();
    return this.deps.store.listByStatus(agent, status, limit).map((row) => ({
      id: row.id, type: row.type, title: row.title, body: row.body, params: parseJson(row.params) ?? {}, createdAt: row.created_at,
    }));
  }

  ack(id: string, agent: InstructionAgent): AckOutcome {
    const row = this.deps.store.find(id);
    if (!row || row.agent !== agent) return { kind: "not_found" };
    const decision = decideAck(row.status);
    if (decision === "conflict") return { kind: "conflict", status: row.status };
    if (decision === "duplicate") return { kind: "duplicate", id, status: "acked", ackedAt: row.acked_at ?? "" };
    const ackedAt = isoSeconds(this.now());
    if (!this.deps.store.markAcked(id, ackedAt)) return this.ackAfterRace(id, agent);
    this.emit({ kind: "acked", id, agent, title: row.title, ackedAt });
    return { kind: "accepted", id, status: "acked", ackedAt };
  }

  recordResult(id: string, input: ResultInput): ResultOutcome {
    const row = this.deps.store.find(id);
    if (!row || row.agent !== input.agent) return { kind: "not_found" };
    const incoming = {
      status: input.status,
      summary: storedSummary(input.summary),
      detail: input.detail === undefined ? null : canonicalJson(input.detail),
    };
    const decision = decideResult({ status: row.status, resultSummary: row.result_summary, resultDetail: row.result_detail }, incoming);
    if (decision === "conflict") return { kind: "conflict", status: row.status };
    if (decision === "duplicate") return { kind: "duplicate", id, status: input.status, finishedAt: row.finished_at ?? "" };
    const finishedAt = isoSeconds(this.now());
    if (!this.deps.store.markFinished(id, { status: input.status, finishedAt, summary: incoming.summary, detail: incoming.detail })) {
      return this.reportAfterRace(id, input);
    }
    this.emit({
      kind: "finished", id, agent: input.agent, title: row.title, status: input.status,
      summary: incoming.summary, detail: incoming.detail, finishedAt,
    });
    return { kind: "accepted", id, status: input.status, finishedAt };
  }

  get(id: string): InstructionState | null {
    const row = this.deps.store.find(id);
    return row ? toState(row) : null;
  }

  /** 新しい順の一覧 (loopback の Web 画面用)。 再配信への戻しを先に済ませ、 見えている状態を poll と揃える。 */
  history(filter: HistoryFilter): InstructionRecord[] {
    this.requeueStale();
    return this.deps.store.listRecent(filter).map((row) => ({
      ...toState(row), body: row.body, params: parseJson(row.params) ?? {}, resultDetail: parseJson(row.result_detail),
    }));
  }

  /** sweeper の周期で呼ぶ。 再配信への戻しと、 90 日を過ぎた終端の削除。 */
  sweep(): { requeued: number; purged: number } {
    const requeued = this.requeueStale();
    const purged = this.deps.store.purgeFinishedBefore(retentionCutoff(this.now()));
    return { requeued, purged };
  }

  private requeueStale(): number {
    const requeued = this.deps.store.requeueAckedBefore(redeliveryCutoff(this.now()));
    for (const row of requeued) this.emit({ kind: "requeued", id: row.id, agent: row.agent, title: row.title });
    return requeued.length;
  }

  /** 受け手の失敗は遷移へ持ち込まない。 */
  private emit(event: InstructionEvent): void {
    try { this.deps.events?.(event); } catch { /* 受け手側で warn する。 ここでは握りつぶして遷移を守る */ }
  }

  /** 条件付き UPDATE が外れた = 判定の後に別の要求が遷移させた。 今の状態で判定し直す (1 回だけ)。 */
  private ackAfterRace(id: string, agent: InstructionAgent): AckOutcome {
    const row = this.deps.store.find(id);
    if (!row || row.agent !== agent) return { kind: "not_found" };
    return row.status === "acked"
      ? { kind: "duplicate", id, status: "acked", ackedAt: row.acked_at ?? "" }
      : { kind: "conflict", status: row.status };
  }

  private reportAfterRace(id: string, input: ResultInput): ResultOutcome {
    const row = this.deps.store.find(id);
    if (!row || row.agent !== input.agent) return { kind: "not_found" };
    const incoming = { status: input.status, summary: storedSummary(input.summary), detail: input.detail === undefined ? null : canonicalJson(input.detail) };
    const decision = decideResult({ status: row.status, resultSummary: row.result_summary, resultDetail: row.result_detail }, incoming);
    return decision === "duplicate"
      ? { kind: "duplicate", id, status: input.status, finishedAt: row.finished_at ?? "" }
      : { kind: "conflict", status: row.status };
  }
}
