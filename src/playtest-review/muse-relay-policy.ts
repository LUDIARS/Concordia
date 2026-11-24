/**
 * Muse の試遊結果の中継の業務判断 (spec/feature/playtest-review-notify.md — Muse の結果の中継)。 I/O を持たない純関数だけ。
 *
 * - 対象: 宛先 muse・type playtest・status done の指令だけ (CC-MUSE-RELAY-INV-01)。
 * - 入力: result の `detail.review` を既存の感想スキーマで検証する。 通らなければ保存も告知もしない (CC-MUSE-RELAY-INV-02)。
 * - 保存: Voluptas の allowlist (ai-playtest-review/1) へ写す。 冪等キーは runId (CC-MUSE-RELAY-INV-03)。
 * - 再試行: 不達・5xx は間隔を倍にして最大 10 回 (最大 6 時間)。 4xx は再試行しない。
 *
 * @implements spec/feature/playtest-review-notify.md — Muse の結果の中継
 */

import type { PlaytestReviewEvent, PlaytestReviewPoint } from "./playtest-review-notice.js";
import { MusePlaytestReviewSchema, type MusePlaytestReview } from "./playtest-review-schema.js";

export const MUSE_RELAY_AGENT = "muse";
export const MUSE_RELAY_TYPE = "playtest";
/** Voluptas の記録に残す送り手の固定値 (Muse の試遊を Cc が中継したもの)。 */
export const MUSE_ENGINE_VERSION = "muse";
export const MUSE_ADAPTER = "cc-muse-relay";
export const VOLUPTAS_REVIEW_FORMAT = "ai-playtest-review/1";
export const VOLUPTAS_REVIEW_SOURCE = "ai-autoplayer";

export const MUSE_RELAY_MAX_ATTEMPTS = 10;
export const MUSE_RELAY_FIRST_DELAY_MS = 60_000;
export const MUSE_RELAY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

export type VoluptasState = "pending" | "saved" | "failed" | "skipped";
/** announcing は「告知を送り始めた」印。 再起動時に残っていれば結果不明として failed にする (再送しない、CC-MUSE-RELAY-INV-04)。 */
export type AnnounceState = "pending" | "announcing" | "delivered" | "failed" | "skipped";

/** 指令が中継の対象か (CC-MUSE-RELAY-INV-01)。 */
export function isMuseRelayTarget(instruction: { agent: string; type: string; status: string }): boolean {
  return instruction.agent === MUSE_RELAY_AGENT && instruction.type === MUSE_RELAY_TYPE && instruction.status === "done";
}

export type ReviewExtraction =
  | { ok: true; review: MusePlaytestReview }
  | { ok: false; reason: string };

/** result の detail (canonical JSON) から `review` を取り出して検証する (CC-MUSE-RELAY-INV-02)。 */
export function extractMuseReview(detail: string | null): ReviewExtraction {
  if (detail === null) return { ok: false, reason: "review_missing: result に detail がありません" };
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch { return { ok: false, reason: "review_missing: detail が JSON ではありません" }; }
  const review = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).review : undefined;
  if (review === undefined) return { ok: false, reason: "review_missing: detail.review がありません" };
  const checked = MusePlaytestReviewSchema.safeParse(review);
  if (checked.success) return { ok: true, review: checked.data };
  const fields = [...new Set(checked.error.issues.map((issue) => issue.path.join(".") || "(review)"))].slice(0, 5);
  return { ok: false, reason: `review_invalid: ${fields.join(", ")}` };
}

function voluptasPoints(points: readonly PlaytestReviewPoint[]): Array<{ aspect: string; text: string; evidence: { ticks: number[]; shots: number[] } }> {
  // Muse の点は根拠の tick / shot を持たない。 Voluptas は evidence を必須にしているので空の配列で渡す。
  return points.map((point) => ({ aspect: point.aspect, text: point.text, evidence: { ticks: [], shots: [] } }));
}

/** Voluptas `POST /api/ai-playtests/reviews` の本文 (allowlist の項目だけ)。 */
export function toVoluptasReview(review: MusePlaytestReview, finishedAt: string): Record<string, unknown> {
  return {
    format: VOLUPTAS_REVIEW_FORMAT,
    source: VOLUPTAS_REVIEW_SOURCE,
    game_id: review.gameId,
    game_title: review.gameTitle,
    run_id: review.runId,
    persona: review.persona,
    engine_version: MUSE_ENGINE_VERSION,
    adapter: MUSE_ADAPTER,
    screen: review.screen,
    ticks: review.ticks,
    turns: review.turns,
    outcome: review.outcome,
    summary: review.summary,
    good: voluptasPoints(review.good),
    bad: voluptasPoints(review.bad),
    confusions: voluptasPoints(review.confusions),
    reflection: review.reflection,
    created_at: finishedAt,
  };
}

/** 告知に渡す感想 (記録 ID 付き)。 */
export function toAnnouncement(review: MusePlaytestReview, voluptasId: string | null): PlaytestReviewEvent {
  return { ...review, voluptasId };
}

export type VoluptasAttempt =
  | { kind: "saved"; id: string }
  | { kind: "rejected"; status: number; code: string | null }
  | { kind: "unavailable"; reason: string };

export type SaveDecision =
  | { state: "saved"; voluptasId: string; error: null; nextAttemptAt: null }
  | { state: "failed"; voluptasId: null; error: string; nextAttemptAt: null }
  | { state: "pending"; voluptasId: null; error: string; nextAttemptAt: number };

/** n 回目 (1 始まり) の失敗の後に待つ時間。 1 分から倍にして 6 時間で頭打ち。 */
export function retryDelayMs(attempts: number): number {
  return Math.min(MUSE_RELAY_FIRST_DELAY_MS * 2 ** Math.max(0, attempts - 1), MUSE_RELAY_MAX_DELAY_MS);
}

/** 保存の試みの結果から次の状態を決める。 attempts は今回を含む試行回数。 */
export function decideSave(attempt: VoluptasAttempt, attempts: number, now: number): SaveDecision {
  if (attempt.kind === "saved") return { state: "saved", voluptasId: attempt.id, error: null, nextAttemptAt: null };
  if (attempt.kind === "rejected" && attempt.status < 500) {
    return { state: "failed", voluptasId: null, error: `voluptas_rejected: HTTP ${attempt.status}${attempt.code ? ` ${attempt.code}` : ""}`, nextAttemptAt: null };
  }
  const reason = attempt.kind === "rejected" ? `voluptas_unavailable: HTTP ${attempt.status}` : `voluptas_unavailable: ${attempt.reason}`;
  if (attempts >= MUSE_RELAY_MAX_ATTEMPTS) return { state: "failed", voluptasId: null, error: `${reason} (${attempts} 回で打ち切り)`, nextAttemptAt: null };
  return { state: "pending", voluptasId: null, error: reason, nextAttemptAt: now + retryDelayMs(attempts) };
}

/** 保存が確定したか (告知へ進んでよいか)。 失敗も確定として告知へ進み、 記録 ID は付けない。 */
export function saveSettled(state: VoluptasState): boolean {
  return state !== "pending";
}

export interface AnnounceSummary {
  duplicate: boolean;
  unconfigured: boolean;
  delivered: number;
  failed: number;
  tabula: "posted" | "failed" | null;
}

/** 告知の結果から台帳の状態を決める。 1 宛先でも届けば delivered (残りの失敗は件数で残す)。 */
export function decideAnnounce(summary: AnnounceSummary): Extract<AnnounceState, "delivered" | "failed" | "skipped"> {
  if (summary.duplicate) return "delivered";
  if (summary.unconfigured) return "skipped";
  return summary.delivered > 0 || summary.tabula === "posted" ? "delivered" : "failed";
}

export interface RelayView {
  voluptasState: VoluptasState;
  voluptasId: string | null;
  announceState: AnnounceState;
  announce: AnnounceSummary | null;
  error: string | null;
  attempts: number;
}

/** 「muse-指令」チャンネルの登録投稿へ 1 回だけ返す中継の状態。 */
export function relayNote(view: RelayView): string {
  const save = view.voluptasState === "saved" ? `Voluptas 保存 ${view.voluptasId ?? ""}`.trim()
    : view.voluptasState === "skipped" ? "Voluptas 保存なし (未設定または対象外)"
      : view.voluptasState === "failed" ? "Voluptas 保存失敗"
        : "Voluptas 保存待ち";
  const announce = view.announceState === "delivered" ? `告知 ${view.announce?.duplicate ? "済み (同じ run を受付済み)" : `${view.announce?.delivered ?? 0} 件${view.announce?.tabula === "posted" ? " + Tabula" : ""}`}`
    : view.announceState === "skipped" ? (view.announce?.unconfigured ? "告知なし (宛先未設定)" : "告知なし")
      : view.announceState === "failed" ? "告知失敗"
        : "告知待ち";
  const failed = view.announce && view.announce.failed > 0 ? ` / 届かなかった宛先 ${view.announce.failed} 件` : "";
  return `中継: ${save} / ${announce}${failed}${view.error ? ` — ${view.error}` : ""}`;
}
