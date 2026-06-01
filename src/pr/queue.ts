/**
 * PR キューの組み立て.
 *
 * pr_records を「対応すべき順」 に並べ替え、 4 つのバケットに分類する.
 * API (/v1/prs)・Discord・MCP がこの 1 関数を共有して表示一貫性を保つ.
 *
 * バケット (active):
 *   ready        ✅ マージ可        (approved)
 *   needs_review 🔍 レビュー待ち     (none / needs_review)
 *   in_progress  🛠 進行中           (reviewing / changes_requested)
 * + merged_recent 🟣 最近マージ (履歴; flat queue には含めない)
 *
 * flat `queue` の優先度: ready(0) → in_progress(1) → needs_review(2).
 * 同 priority 内は ci failure を先頭に、 以降 updated_at 降順.
 */

import type { PrRecordRow, PrRecordsRepo } from "../db/pr-records-repo.js";

export type PrBucket = "ready" | "needs_review" | "in_progress";

export interface PrQueueResult {
  generated_at: number;
  counts: {
    ready: number;
    needs_review: number;
    in_progress: number;
    merged_recent: number;
    total_active: number;
  };
  grouped: {
    ready: PrRecordRow[];
    needs_review: PrRecordRow[];
    in_progress: PrRecordRow[];
    merged_recent: PrRecordRow[];
  };
  /** active な PR を対応優先度順に並べた平坦リスト. */
  queue: PrRecordRow[];
}

export function bucketOf(row: PrRecordRow): PrBucket {
  if (row.review_state === "approved") return "ready";
  if (row.review_state === "reviewing" || row.review_state === "changes_requested") {
    return "in_progress";
  }
  return "needs_review";
}

const BUCKET_PRIORITY: Record<PrBucket, number> = {
  ready: 0,
  in_progress: 1,
  needs_review: 2,
};

function compareForQueue(a: PrRecordRow, b: PrRecordRow): number {
  const pa = BUCKET_PRIORITY[bucketOf(a)];
  const pb = BUCKET_PRIORITY[bucketOf(b)];
  if (pa !== pb) return pa - pb;
  // ci failure を先頭に (対応が要る)
  const fa = a.ci_status === "failure" ? 0 : 1;
  const fb = b.ci_status === "failure" ? 0 : 1;
  if (fa !== fb) return fa - fb;
  return b.updated_at - a.updated_at;
}

export function buildPrQueue(repo: PrRecordsRepo, mergedRecentLimit = 10): PrQueueResult {
  const active = repo.listActive();
  const mergedRecent = repo.listRecentlyMerged(mergedRecentLimit);

  const grouped: PrQueueResult["grouped"] = {
    ready: [],
    needs_review: [],
    in_progress: [],
    merged_recent: mergedRecent,
  };
  for (const row of active) {
    grouped[bucketOf(row)].push(row);
  }

  const queue = [...active].sort(compareForQueue);

  return {
    generated_at: Math.floor(Date.now() / 1000),
    counts: {
      ready: grouped.ready.length,
      needs_review: grouped.needs_review.length,
      in_progress: grouped.in_progress.length,
      merged_recent: mergedRecent.length,
      total_active: active.length,
    },
    grouped,
    queue,
  };
}
