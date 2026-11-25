/**
 * Quaestor の常駐巡回 (GET /v1/mail/crawler) の状態を、外部エージェントへ渡せる欄だけに射影する。
 * Quaestor は巡回が取り込みを所有しているとき手動 sweep を 409 で断るため、メール監視は巡回の状態を報告する。
 * 渡さないもの: backfill の requestId、メール本文・件名・差出人・アドレス、内部 URL・パス、秘密。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — メール取り込みの許可リスト (常駐巡回)
 */

const TOKEN_PATTERN = /^[a-z0-9_]{1,64}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function token(value: unknown): string | null {
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : null;
}

function isoTime(value: unknown): string | null {
  const ms = count(value);
  return ms === null ? null : new Date(ms).toISOString();
}

export interface MailCrawlerData {
  ready: boolean;
  running: boolean;
  pending: number | null;
  processed: number | null;
  failures: number | null;
  next_at: string | null;
  last_failure: { stage: string | null; category: string | null; http_status: number | null; at: string | null } | null;
  backfill: { status: string | null; processed: number | null } | null;
}

/** 純関数: 巡回の状態を許可した欄だけにする。 形が合わなければ null。 */
export function projectMailCrawler(payload: unknown): MailCrawlerData | null {
  const row = record(payload);
  if (!row || typeof row.ready !== "boolean" || typeof row.running !== "boolean") return null;
  const failure = record(row.lastFailure);
  const backfill = record(row.backfill);
  return {
    ready: row.ready,
    running: row.running,
    pending: count(row.pending),
    processed: count(row.processed),
    failures: count(row.failures),
    next_at: isoTime(row.nextAt),
    last_failure: failure ? {
      stage: token(failure.stage), category: token(failure.category), http_status: count(failure.status), at: isoTime(failure.at),
    } : null,
    backfill: backfill ? { status: token(backfill.status), processed: count(backfill.processed) } : null,
  };
}

/** 409 の本文が「巡回が取り込みを所有している」ことを示すか。 */
export function isCrawlerOwnedConflict(payload: unknown): boolean {
  const error = record(payload)?.error;
  return typeof error === "string" && error.startsWith("crawler owns ingestion");
}
