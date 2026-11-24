/**
 * Muse の試遊結果の中継 (spec/feature/playtest-review-notify.md — Muse の結果の中継)。
 *
 * 指令の finished → 台帳に載せる → Voluptas へ保存 → 記録 ID を付けて既存の告知 → 「muse-指令」へ状態を 1 回返す。
 *
 * - 台帳への記録は出来事を受けたその場で同期に行う (受けた結果を取りこぼさない)。 外部への送信はその後。
 * - 保存が確定 (saved / skipped / failed) するまで告知しない (CC-MUSE-RELAY-INV-03)。
 * - 告知の前に台帳を announcing にする。 告知の途中で止まった行は再起動時に結果不明の failed にし、 再送しない (CC-MUSE-RELAY-INV-04)。
 * - Voluptas の鍵はログ・台帳・投稿に入れない (CC-MUSE-RELAY-INV-05)。
 *
 * @implements spec/feature/playtest-review-notify.md — Muse の結果の中継
 */

import type { InstructionEvent } from "../agent-instructions/instruction-events.js";
import type { MusePlaytestRelayRow, MusePlaytestRelayStore } from "../db/muse-playtest-relays-repo.js";
import type { PlaytestReviewOutcome } from "./handle-playtest-review.js";
import {
  decideAnnounce,
  decideSave,
  extractMuseReview,
  isMuseRelayTarget,
  relayNote,
  toAnnouncement,
  toVoluptasReview,
  type AnnounceSummary,
  type RelayView,
  type VoluptasAttempt,
} from "./muse-relay-policy.js";
import type { PlaytestReviewEvent } from "./playtest-review-notice.js";
import type { MusePlaytestReview } from "./playtest-review-schema.js";
import type { VoluptasConnection } from "./voluptas-client.js";

export const ANNOUNCE_UNKNOWN_ON_RESTART = "announce_unknown: 告知の途中で Cc が止まりました (結果不明のため再送しません)";
export const ANNOUNCE_UNKNOWN_ON_ERROR = "announce_unknown: 告知の途中で失敗しました (結果不明のため再送しません)";
const DUE_BATCH = 20;

export interface MuseRelayLog {
  info: (detail: Record<string, unknown>, message: string) => void;
  warn: (detail: Record<string, unknown>, message: string) => void;
}

export interface MuseRelayDeps {
  store: MusePlaytestRelayStore;
  /** 指令の type。 見つからなければ null。 */
  instructionType: (id: string) => string | null;
  /** 設定 `playtest_notify.muse_relay_enabled`。 */
  enabled: () => boolean;
  /** Voluptas の接続先。 未設定なら null (保存を skipped にする)。 鍵を読めなければ throw してよい (再試行に回す)。 */
  voluptas: () => VoluptasConnection | null;
  save: (connection: VoluptasConnection, runId: string, body: Record<string, unknown>) => Promise<VoluptasAttempt>;
  announce: (event: PlaytestReviewEvent) => Promise<PlaytestReviewOutcome>;
  /** 「muse-指令」チャンネルの登録投稿へ返す (best-effort)。 */
  note: (id: string, agent: string, text: string) => void;
  log: MuseRelayLog;
  now?: () => number;
}

function summarize(outcome: PlaytestReviewOutcome): AnnounceSummary {
  return {
    duplicate: outcome.duplicate,
    unconfigured: outcome.unconfigured,
    delivered: outcome.delivered.length,
    failed: outcome.failed.length,
    tabula: outcome.tabula === null ? null : "url" in outcome.tabula ? "posted" : "failed",
  };
}

function parseSummary(raw: string | null): AnnounceSummary | null {
  if (raw === null) return null;
  try { return JSON.parse(raw) as AnnounceSummary; } catch { return null; }
}

export function relayView(row: MusePlaytestRelayRow): RelayView {
  return {
    voluptasState: row.voluptas_state,
    voluptasId: row.voluptas_id,
    announceState: row.announce_state,
    announce: parseSummary(row.announce_result),
    error: row.error,
    attempts: row.attempts,
  };
}

export class MusePlaytestRelay {
  private readonly now: () => number;
  private readonly inflight = new Set<string>();

  constructor(private readonly deps: MuseRelayDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 指令の出来事の受け手。 台帳への記録までを同期に済ませ、 外部への送信の Promise を返す。 */
  handle(event: InstructionEvent): Promise<void> {
    if (event.kind !== "finished" || !this.deps.enabled()) return Promise.resolve();
    const type = this.deps.instructionType(event.id);
    if (type === null || !isMuseRelayTarget({ agent: event.agent, type, status: event.status })) return Promise.resolve();
    const extraction = extractMuseReview(event.detail);
    const now = this.now();
    if (!extraction.ok) {
      const inserted = this.deps.store.insertIfAbsent({
        instructionId: event.id, runId: null, finishedAt: event.finishedAt, reviewJson: null,
        voluptasState: "skipped", announceState: "skipped", error: extraction.reason,
      }, now);
      if (inserted) {
        this.deps.log.warn({ id: event.id, reason: extraction.reason }, "muse playtest result was not relayed");
        this.report(event.id, event.agent);
      }
      return Promise.resolve();
    }
    const inserted = this.deps.store.insertIfAbsent({
      instructionId: event.id, runId: extraction.review.runId, finishedAt: event.finishedAt, reviewJson: JSON.stringify(extraction.review),
      voluptasState: "pending", announceState: "pending", error: null,
    }, now);
    return inserted ? this.advance(event.id) : Promise.resolve();
  }

  /** 起動時に 1 回。 告知の途中で止まった行を結果不明にし、 残りを進める。 */
  async resume(): Promise<void> {
    for (const row of this.deps.store.abandonAnnouncing(ANNOUNCE_UNKNOWN_ON_RESTART, this.now())) {
      this.deps.log.warn({ id: row.instruction_id, runId: row.run_id }, "muse playtest announcement result is unknown after restart; not resending");
      this.report(row.instruction_id, "muse");
    }
    await this.tick();
  }

  /** 周期で呼ぶ。 再試行の時刻が来た行と、 告知が未着手の行を進める。 */
  async tick(): Promise<void> {
    if (!this.deps.enabled()) return;
    for (const row of this.deps.store.listDue(this.now(), DUE_BATCH)) await this.advance(row.instruction_id);
  }

  view(id: string): RelayView | null {
    const row = this.deps.store.find(id);
    return row ? relayView(row) : null;
  }

  private async advance(id: string): Promise<void> {
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    try {
      const row = this.deps.store.find(id);
      if (!row || row.review_json === null) return;
      const review = JSON.parse(row.review_json) as MusePlaytestReview;
      if (row.voluptas_state === "pending" && !(await this.save(row, review))) return;
      const settled = this.deps.store.find(id);
      if (settled && settled.announce_state === "pending") await this.announce(settled, review);
    } catch (error) {
      this.deps.log.warn({ id, error: error instanceof Error ? error.message : String(error) }, "muse playtest relay step failed");
    } finally {
      this.inflight.delete(id);
    }
  }

  /** 保存を 1 回試す。 確定 (saved / skipped / failed) したら true。 */
  private async save(row: MusePlaytestRelayRow, review: MusePlaytestReview): Promise<boolean> {
    let connection: VoluptasConnection | null;
    let attempt: VoluptasAttempt | null = null;
    try {
      connection = this.deps.voluptas();
    } catch {
      connection = null;
      attempt = { kind: "unavailable", reason: "Voluptas の鍵を読めません" };
    }
    if (connection === null && attempt === null) {
      this.deps.store.recordSave(row.instruction_id, { state: "skipped", voluptasId: null, error: null, attempts: row.attempts, nextAttemptAt: null }, this.now());
      return true;
    }
    if (connection !== null) attempt = await this.deps.save(connection, review.runId, toVoluptasReview(review, row.finished_at));
    const attempts = row.attempts + 1;
    const decision = decideSave(attempt as VoluptasAttempt, attempts, this.now());
    this.deps.store.recordSave(row.instruction_id, { state: decision.state, voluptasId: decision.voluptasId, error: decision.error, attempts, nextAttemptAt: decision.nextAttemptAt }, this.now());
    const detail = { id: row.instruction_id, runId: review.runId, state: decision.state, attempts, ...(decision.voluptasId ? { voluptasId: decision.voluptasId } : {}), ...(decision.error ? { error: decision.error } : {}) };
    if (decision.state === "saved") this.deps.log.info(detail, "muse playtest review saved to Voluptas");
    else this.deps.log.warn(detail, decision.state === "pending" ? "muse playtest review save will be retried" : "muse playtest review could not be saved");
    return decision.state !== "pending";
  }

  private async announce(row: MusePlaytestRelayRow, review: MusePlaytestReview): Promise<void> {
    if (!this.deps.store.beginAnnounce(row.instruction_id, this.now())) return;
    const voluptasId = row.voluptas_state === "saved" ? row.voluptas_id : null;
    try {
      const summary = summarize(await this.deps.announce(toAnnouncement(review, voluptasId)));
      const state = decideAnnounce(summary);
      this.deps.store.finishAnnounce(row.instruction_id, {
        state, result: JSON.stringify(summary), error: state === "failed" ? "announce_failed: どの宛先にも届きませんでした" : null,
      }, this.now());
    } catch (error) {
      this.deps.log.warn({ id: row.instruction_id, error: error instanceof Error ? error.message : String(error) }, "muse playtest announcement failed with unknown result");
      this.deps.store.finishAnnounce(row.instruction_id, { state: "failed", result: null, error: ANNOUNCE_UNKNOWN_ON_ERROR }, this.now());
    }
    this.report(row.instruction_id, "muse");
  }

  private report(id: string, agent: string): void {
    const view = this.view(id);
    if (!view) return;
    try { this.deps.note(id, agent, relayNote(view)); } catch { /* 投稿は後追い。 受け手側で warn する */ }
  }
}
