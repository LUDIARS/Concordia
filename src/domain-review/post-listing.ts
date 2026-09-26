/**
 * src/domain-review/post-listing.ts — ドメインレビュー投稿一覧の読み取り。
 *
 * Breviarium が「このプロジェクトの最新のドメインレビューはいつか」を読むための
 * read model。 返すのは「いつ・どの契機で・どの規模のレビューを出したか」の事実だけで、
 * レポート本文・問いの本文・Discord の宛先は返さない (本文の正本は Discord の投稿)。
 * 見送った投稿は台帳に残らないので、 ここにも出ない — 投稿していないものを投稿済みに
 * 見せない (CC-INV-04)。
 *
 * SRP: 件数上限の解決と、 台帳行 → 本文を含めない要約への射影。 SQL は repo、
 * HTTP の形 (snake_case) は api 側が持つ。
 *
 * @implements spec/feature/domain-review-discord.md §8
 */

import { parsePostQuestions, type DomainReviewPostListRow, type DomainReviewRepo } from "../db/domain-review-repo.js";
import { clampListLimit } from "../db/list-limit.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:da74de76 */
import augurContract_085b36fe from './post-listing.contract.js'; /* augur-inject:contract-predicate:b42bdbf6 */
import augurContract_35a21afe from './post-listing.contract.js'; /* augur-inject:contract-predicate:821131ee */

/** 件数指定が無いときの返却件数。 */
export const DOMAIN_REVIEW_POSTS_DEFAULT_LIMIT = 20;
/** 1 回で返す上限。 最新投稿の日時を読む用途には十分で、 超えた指定はここへ丸める。 */
export const DOMAIN_REVIEW_POSTS_MAX_LIMIT = 100;

/** 一覧の 1 件。 規模は件数だけで表し、 本文は持たない。 */
export interface DomainReviewPostSummary {
  id: number;
  /** project_codes.code。 */
  code: string;
  /** project_codes の現在の repo_origin。 登録から消えた code は null。 */
  repoOrigin: string | null;
  /** 投稿の契機 (plan / local-pr / manual)。 */
  trigger: string;
  /** レポートの出所 (prepared / raw)。 migration 111 より前の投稿は null。 */
  source: string | null;
  /** 投稿を台帳へ記録した時刻 (UTC ISO 8601)。 */
  postedAt: string;
  coreDomains: number | null;
  layers: number | null;
  layerViolations: number | null;
  planQuestions: number;
}

export interface DomainReviewPostListQuery {
  /** project_codes.code。 null なら全プロジェクト。 */
  code: string | null;
  /** 要求件数。 クエリ文字列のままでよい (解決は resolvePostListLimit)。 */
  limit?: unknown;
}

/**
 * 要求件数を 1..上限 に丸める。 空・非数値の扱いは一覧系共通の clampListLimit に
 * 揃え、 上限だけこの一覧のものを重ねる。
 */
export function resolvePostListLimit(requested: unknown): number {
  return Math.min(
    DOMAIN_REVIEW_POSTS_MAX_LIMIT,
    clampListLimit(requested, DOMAIN_REVIEW_POSTS_DEFAULT_LIMIT),
  );
}

/** 台帳行を一覧の要約へ写す。 channel / message id と問いの本文はここで落とす。 */
export function summarizeDomainReviewPost(row: DomainReviewPostListRow): DomainReviewPostSummary {
  return {
    id: row.id,
    code: row.code,
    repoOrigin: row.repo_origin,
    trigger: row.trigger_kind,
    source: row.report_source,
    postedAt: new Date(row.created_at).toISOString(),
    coreDomains: row.core_domain_count,
    layers: row.layer_count,
    layerViolations: row.layer_violation_count,
    planQuestions: parsePostQuestions(row).length,
  };
}
// @ts-expect-error augur-inject
summarizeDomainReviewPost = contract(summarizeDomainReviewPost, { ...augurContract_35a21afe, contractId: 'C-11', mode: 'observe', sample: 1, where: 'src/domain-review/post-listing.ts:62', rule: 'contract-wrap', id: '35a21afe' }); /* augur-inject:contract-wrap:35a21afe */

/** 投稿を新しい順に、 解決した件数まで返す。 */
export function listDomainReviewPosts(
  posts: Pick<DomainReviewRepo, "listByCode">,
  query: DomainReviewPostListQuery,
): DomainReviewPostSummary[] {
  return posts.listByCode(query.code, resolvePostListLimit(query.limit))
    .map((row) => summarizeDomainReviewPost(row));
}
// @ts-expect-error augur-inject
listDomainReviewPosts = contract(listDomainReviewPosts, { ...augurContract_085b36fe, contractId: 'C-10', mode: 'observe', sample: 1, where: 'src/domain-review/post-listing.ts:78', rule: 'contract-wrap', id: '085b36fe' }); /* augur-inject:contract-wrap:085b36fe */
