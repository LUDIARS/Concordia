/**
 * 兄弟サービス (および自分自身) の base URL 解決。
 *
 * 集約前は同じ既定値が複数ファイルに `DEFAULT_BASE_URL` として重複定義され、
 * 参照する env キーも呼び出し元ごとに揺れていた
 * (例: Excubitor は client.ts が `CONCORDIA_EXCUBITOR_URL` のみ、
 * discord/excubitor-project-cache.ts は `EXCUBITOR_URL` も見る)。
 * 「どのサービスをどの env で指すか」 の正本をここに一本化する。
 *
 * ポートについて: port-source-rule のとおり **正本は Excubitor catalog**。
 * この同期 helper は catalog を照会せず、 env が無い場合は各 consumer が従来持っていた
 * 互換 fallback を返す。 実効ポートが必要な制御経路は `excubitor/service-port.ts` の
 * `resolveServicePort` で観測値 → catalog の順に解決し、この helper を使わない。
 */

import { readPortEnv, stripTrailingSlashes, trimmedEnv } from "./env-parse.js";

/** env 未設定時の従来互換 fallback。ポートの正本ではない。 */
const FALLBACK_BASE_URL = {
  concordia: "http://127.0.0.1:11111",
  excubitor: "http://127.0.0.1:17332",
  memoria: "http://127.0.0.1:5180",
  anatomia: "http://127.0.0.1:4200",
  thaleia: "http://127.0.0.1:8890",
  villa: "http://127.0.0.1:17610",
} as const;

/** 先に見つかった非空の env 値を採用し、 無ければ既定へ落とす。 末尾スラッシュは除去。 */
function resolveBaseUrl(candidates: Array<string | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    const value = trimmedEnv(candidate);
    if (value) return stripTrailingSlashes(value);
  }
  return stripTrailingSlashes(fallback);
}

/** Concordia 自身の HTTP API (MCP サーバ等、 別プロセスから叩く側が使う)。 */
export function concordiaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl([env.CONCORDIA_BASE_URL], FALLBACK_BASE_URL.concordia);
}

/** Excubitor (サービス監視)。 Excubitor 自身の慣用キー `EXCUBITOR_URL` も受ける。 */
export function excubitorBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl(
    [env.CONCORDIA_EXCUBITOR_URL, env.EXCUBITOR_URL],
    FALLBACK_BASE_URL.excubitor,
  );
}

/** Memoria (メモリ / ノート)。 */
export function memoriaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl([env.CONCORDIA_MEMORIA_URL], FALLBACK_BASE_URL.memoria);
}

/**
 * Anatomia (リポジトリ解析)。
 *
 * base URL 指定が無いときだけ、 catalog 注入の `ANATOMIA_PORT` から loopback URL を組む。
 * ポート文字列の解釈は `env-parse.ts` の責務 (不正値は既定へ落とさず投げる)。
 */
export function anatomiaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configuredBaseUrl = trimmedEnv(env.ANATOMIA_BASE_URL);
  if (configuredBaseUrl) {
    return resolveBaseUrl([configuredBaseUrl], FALLBACK_BASE_URL.anatomia);
  }
  const configuredPort = readPortEnv(env.ANATOMIA_PORT, "ANATOMIA_PORT");
  return resolveBaseUrl(
    [configuredPort ? `http://127.0.0.1:${configuredPort}` : undefined],
    FALLBACK_BASE_URL.anatomia,
  );
}

/** Thaleia (ドキュメント / 仕様)。 */
export function thaleiaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl([env.THALEIA_BASE_URL], FALLBACK_BASE_URL.thaleia);
}

/** Villa (PC 台帳)。 */
export function villaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl([env.CONCORDIA_VILLA_URL], FALLBACK_BASE_URL.villa);
}
