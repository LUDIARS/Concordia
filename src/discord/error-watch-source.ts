/**
 * エラー監視 (error-monitor.ts) がログを読む先。
 *
 * VictoriaLogs の URL があればそこから読む (ログの正本、neco 2026-11-25)。無ければ従来どおり
 * Vestigium の JSONL ファイル (`<root>/<service-code>/YYYY-MM-DD.jsonl`) を読む。
 * どちらも無ければ監視しない。
 */

import { listVestigiumServices, recent, type VestigiumRecord } from "../mcp/vestigium-reader.js";
import { createVictoriaLogsReader, type FetchLike } from "../mcp/victorialogs-reader.js";

export interface ErrorWatchSource {
  readonly label: string;
  listServices(): Promise<string[]>;
  recentErrors(service: string, since: number): Promise<VestigiumRecord[]>;
}

const ERROR_LEVELS: VestigiumRecord["level"][] = ["error", "fatal"];
const ERROR_BATCH = 200;

/** VictoriaLogs の URL。Concordia 専用の名前を優先し、Vestigium の catalog が配る名前も受ける。 */
export function victoriaLogsUrl(env: Record<string, string | undefined>): string | null {
  const value = (env.CONCORDIA_LOGS_VICTORIALOGS_URL ?? env.VESTIGIUM_VICTORIALOGS_URL ?? "").trim();
  return value || null;
}

export function fileErrorWatchSource(root: string): ErrorWatchSource {
  return {
    label: `files root=${root}`,
    listServices: () => listVestigiumServices(root),
    recentErrors: (service, since) => recent({ logPath: `${root}/${service}`, limit: ERROR_BATCH, level: ERROR_LEVELS, since }),
  };
}

export function victoriaErrorWatchSource(origin: string, fetchImpl?: FetchLike): ErrorWatchSource {
  const reader = createVictoriaLogsReader({ origin, fetch: fetchImpl });
  return {
    label: `victorialogs ${new URL(origin).origin}`,
    listServices: () => reader.listServices(),
    recentErrors: (service, since) => reader.recent({ service, limit: ERROR_BATCH, level: ERROR_LEVELS, since }),
  };
}

/** env から読む先を決める。どちらの設定も無ければ null (監視しない)。 */
export function resolveErrorWatchSource(env: Record<string, string | undefined>): ErrorWatchSource | null {
  const url = victoriaLogsUrl(env);
  if (url) return victoriaErrorWatchSource(url);
  const root = env.CONCORDIA_ERROR_WATCH_LOGS_ROOT?.trim();
  return root ? fileErrorWatchSource(root) : null;
}
