/**
 * 検証済みの AI プレイテスト感想を告知する use case。 受け口 (`POST /v1/events/playtest-review`) と
 * Muse の結果の中継 (muse-relay.ts) が同じ手順を通る (HTTP を経由しない)。
 *
 * 1. CDGD 変更列へ記録する (`ig:playtest-review:<runId>`)。 重複でも記録の欠けを直せるよう配送より先に呼ぶ。
 * 2. 宛先 (Discord / Slack / Tabula) へ配送する (handlePlaytestReview)。
 * 3. 配送の証跡を残す。 記録と証跡の失敗は配送を止めない (warn だけ)。
 *
 * @implements spec/feature/playtest-review-notify.md — 受付と配送
 */

import type { DeploymentDelivery } from "../deploy/service-deployed.js";
import type { PlaytestDeliveryEvidence } from "./delivery-evidence.js";
import { handlePlaytestReview, type PlaytestReviewOutcome, type PlaytestReviewTargets } from "./handle-playtest-review.js";
import { toPlaytestManagementEvent } from "./management-event.js";
import type { PlaytestReviewEvent } from "./playtest-review-notice.js";
import type { PlaytestReviewTabula } from "./playtest-review-tabula.js";
import type { PlaytestReviewVideo, PlaytestVideoDelivery } from "./playtest-review-video.js";
import type { PlaytestReviewLedger } from "./recent-run-ledger.js";

export interface PlaytestAnnounceLog {
  info: (detail: Record<string, unknown>, message: string) => void;
  warn: (detail: Record<string, unknown>, message: string) => void;
}

export interface PlaytestAnnounceDeps {
  ledger: PlaytestReviewLedger;
  targets: PlaytestReviewTargets;
  delivery: DeploymentDelivery;
  tabula?: PlaytestReviewTabula;
  videoDelivery?: PlaytestVideoDelivery;
  recordManagementEvent?: (event: ReturnType<typeof toPlaytestManagementEvent>) => void;
  deliveryEvidence?: Pick<PlaytestDeliveryEvidence, "record">;
  log?: PlaytestAnnounceLog;
}

/** 応答とログに載せる配送の要約 (宛先の識別子だけ。 URL・鍵は持たない)。 */
export function describePlaytestOutcome(event: PlaytestReviewEvent, outcome: PlaytestReviewOutcome): Record<string, unknown> {
  return {
    runId: event.runId,
    gameId: event.gameId,
    duplicate: outcome.duplicate,
    unconfigured: outcome.unconfigured,
    delivered: outcome.delivered.map((result) => result.target),
    failed: outcome.failed.map((result) => ({ ...result.target, error: result.error })),
    tabula: outcome.tabula,
    video: outcome.video && { delivered: outcome.video.delivered.map((result) => result.target), failed: outcome.video.failed.map((result) => ({ ...result.target, error: result.error })) },
  };
}

export async function announcePlaytestReview(deps: PlaytestAnnounceDeps, event: PlaytestReviewEvent, video?: PlaytestReviewVideo): Promise<PlaytestReviewOutcome> {
  try {
    deps.recordManagementEvent?.(toPlaytestManagementEvent(event));
  } catch {
    deps.log?.warn({ runId: event.runId }, "playtest-review management event could not be recorded");
  }
  const outcome = await handlePlaytestReview({
    event,
    ledger: deps.ledger,
    targets: deps.targets,
    delivery: deps.delivery,
    ...(deps.tabula ? { tabula: deps.tabula } : {}),
    ...(video ? { video } : {}),
    ...(deps.videoDelivery ? { videoDelivery: deps.videoDelivery } : {}),
  });
  try {
    deps.deliveryEvidence?.record(outcome);
  } catch {
    deps.log?.warn({ runId: event.runId }, "playtest-review delivery evidence could not be recorded");
  }
  const detail = describePlaytestOutcome(event, outcome);
  if (outcome.failed.length > 0 || (outcome.video?.failed.length ?? 0) > 0 || (outcome.tabula !== null && "error" in outcome.tabula)) deps.log?.warn(detail, "playtest-review delivery failed");
  else deps.log?.info(detail, outcome.unconfigured ? "playtest-review skipped because no destination is configured" : "playtest-review delivery completed");
  return outcome;
}
