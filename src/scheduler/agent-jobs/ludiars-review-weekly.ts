/**
 * 週次レビュー (`ludiars-review-weekly`) の外部エージェント版。
 * 対象リポの正確な ref と差分の統計・ファイル一覧だけを渡し (コード本文は渡さない)、 見るべき所の提案を返してもらう。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 週次レビュー
 */

import { composeAgentBody } from "./body.js";
import type { AgentJobSpec } from "./types.js";

export const LUDIARS_REVIEW_WEEKLY_JOB = "ludiars-review-weekly";

/** 1 リポあたりに渡すファイル数の上限。 */
export const REVIEW_FILES_PER_REPO = 30;

export interface ReviewChangedFile {
  path: string;
  added: number | null;
  deleted: number | null;
}

export interface ReviewTarget {
  repo: string;
  code: string | null;
  /** ローカル main の commit。 読めなければ null。 */
  head: string | null;
  /** 前回レビューの HEAD (Review/<repo>/latest.json)。 */
  previousHead: string | null;
  reviewedAt: string | null;
  /** previousHead..head の commit 数。 */
  commits: number | null;
  files: ReviewChangedFile[];
}

export interface ReviewWeeklySources {
  reviewTargets(): Promise<ReviewTarget[]>;
}

function statusOf(target: ReviewTarget): "changed" | "unchanged" | "unknown" {
  if (!target.head || !target.previousHead) return "unknown";
  return target.head === target.previousHead ? "unchanged" : "changed";
}

const STATUS_ORDER = { changed: 0, unknown: 1, unchanged: 2 } as const;

export function createLudiarsReviewWeeklyJob(sources: ReviewWeeklySources): AgentJobSpec {
  return {
    jobName: LUDIARS_REVIEW_WEEKLY_JOB,
    resultKind: "提案",
    body: composeAgentBody([
      "LUDIARS Tier 1 リポの週次レビューで、 どこを重点的に見るべきかを提案する回です。",
      "",
      "params.data.repos は、 リポごとの前回レビューの HEAD から今回の HEAD までの差分の統計とファイル一覧です",
      "(コード本文は含みません)。 変更の大きいファイル・設計の境界 (API・DB・認証・設定) に触れていそうな変更を挙げ、",
      "リポごとに「見るべきファイルと理由」を detail.items に返してください。 status が unknown のリポは ref が取れていません。",
    ]),
    async buildData(context) {
      const repos = (await sources.reviewTargets())
        .map((target) => ({ target, status: statusOf(target) }))
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.target.files.length - a.target.files.length)
        .map(({ target, status }) => ({
          repo: target.repo,
          code: target.code,
          status,
          head: target.head,
          previous_head: target.previousHead,
          reviewed_at: target.reviewedAt,
          commits: target.commits,
          files_total: target.files.length,
          files: target.files
            .slice()
            .sort((a, b) => ((b.added ?? 0) + (b.deleted ?? 0)) - ((a.added ?? 0) + (a.deleted ?? 0)))
            .slice(0, REVIEW_FILES_PER_REPO)
            .map((file) => ({ path: file.path, added: file.added, deleted: file.deleted })),
        }));
      return { date: context.args.date ?? null, repos };
    },
  };
}
