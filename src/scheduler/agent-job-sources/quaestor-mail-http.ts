import type { ExcubitorClient } from "../../excubitor/client.js";
import { resolveServicePort } from "../../excubitor/service-port.js";
import { isCrawlerOwnedConflict, projectMailCrawler } from "../agent-jobs/quaestor-mail-crawler-data.js";
import { projectMailSweep, projectReviewIds, type MailSweepData } from "../agent-jobs/quaestor-mail-sweep-data.js";

const SWEEP_TIMEOUT_MS = 90_000;
const READ_TIMEOUT_MS = 5_000;

/** 要確認の文書 ID を読む。 読めなければ null (取り込みの再送や取消にはならない)。 */
async function readReviewIds(url: string, request: typeof fetch): Promise<string[] | null> {
  try {
    const documents = await request(`${url}/documents?status=needs_review`, {
      redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (documents.ok) return projectReviewIds(await documents.json());
    await documents.body?.cancel();
  } catch {
    // This read cannot invalidate or repeat the sweep. Report missing IDs with its counts.
  }
  return null;
}

function withReviewIds<T extends object>(data: T, ids: string[] | null) {
  return { ...data, needs_review_ids: ids ?? [], ...(ids === null ? { needs_review_ids_unavailable: true as const } : {}) };
}

/** 常駐巡回が取り込みを所有しているとき、 巡回の状態 (GET /v1/mail/crawler) を読む。 */
async function readCrawler(url: string, request: typeof fetch): Promise<MailSweepData> {
  let crawler: ReturnType<typeof projectMailCrawler> = null;
  try {
    const response = await request(`${url}/crawler`, { redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (response.ok) crawler = projectMailCrawler(await response.json().catch(() => null));
    else await response.body?.cancel();
  } catch {
    // The crawler status is a read; a lost response only means the state is unknown.
  }
  if (!crawler) return { sweep_status: "failed", failure_kind: "crawler_unavailable" };
  return withReviewIds({ sweep_status: "crawler" as const, crawler }, await readReviewIds(url, request));
}

export function createQuaestorMailSweep(excubitor: Pick<ExcubitorClient, "findService">, request: typeof fetch = fetch) {
  return async (): Promise<MailSweepData> => {
    let port: number | null;
    try {
      port = resolveServicePort(await excubitor.findService("quaestor", READ_TIMEOUT_MS));
    } catch {
      return { sweep_status: "failed", failure_kind: "endpoint_unavailable" };
    }
    if (!port) return { sweep_status: "failed", failure_kind: "endpoint_unavailable" };

    const url = `http://127.0.0.1:${port}/v1/mail`;
    const signal = AbortSignal.timeout(SWEEP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await request(`${url}/sweep`, {
        method: "POST", body: "{}", headers: { "content-type": "application/json" }, redirect: "error", signal,
      });
    } catch {
      // A lost response does not establish whether Quaestor committed the sweep.
      return { sweep_status: "unknown", failure_kind: signal.aborted ? "timeout" : "transport" };
    }
    if (response.status === 409) {
      // Quaestor refuses a manual sweep while its crawler owns ingestion. Only the error code is inspected.
      if (isCrawlerOwnedConflict(await response.json().catch(() => null))) return readCrawler(url, request);
      return { sweep_status: "failed", failure_kind: "http_error", http_status: 409 };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined); // The status alone is safe to retain.
      return { sweep_status: response.status >= 500 ? "unknown" : "failed", failure_kind: "http_error", http_status: response.status };
    }
    const sweep = projectMailSweep(await response.json().catch(() => null));
    if (!sweep) return { sweep_status: "unknown", failure_kind: signal.aborted ? "timeout" : "invalid_response" };
    if (sweep.disabled) return { ...sweep, sweep_status: "disabled", needs_review_ids: [] };
    if (sweep.needs_review === 0) return { ...sweep, sweep_status: "completed", needs_review_ids: [] };
    return withReviewIds({ ...sweep, sweep_status: "completed" as const }, await readReviewIds(url, request));
  };
}
