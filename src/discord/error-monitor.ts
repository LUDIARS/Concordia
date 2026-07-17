/**
 * Vestigium ログのエラー監視 (取り込み: 監視ロガー → reportError).
 *
 * env `CONCORDIA_ERROR_WATCH_LOGS_ROOT` に Vestigium のログ root
 * (`<root>/<service-code>/YYYY-MM-DD.jsonl` 構造) を指定すると、 各サービスの
 * error/fatal エントリを定期 poll して reportError する → Discord errors チャンネルへ.
 * 未指定なら完全 no-op (catalog を持たない Concordia でも安全).
 *
 * 初回 poll は watermark=now で「過去ログのダンプ」 を避け、 以降の新規エラーのみ拾う.
 */

import { listVestigiumServices, recent } from "../mcp/vestigium-reader.js";
import { reportError } from "../errors.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("error-monitor");

export interface ErrorMonitorHandle {
  stop: () => void;
  /** テスト/手動用: 1 周回す. */
  runOnce: () => Promise<void>;
}

export function startVestigiumErrorWatch(): ErrorMonitorHandle {
  const root = process.env.CONCORDIA_ERROR_WATCH_LOGS_ROOT;
  const intervalSec = Math.max(10, Number(process.env.CONCORDIA_ERROR_WATCH_INTERVAL_SEC ?? "30") || 30);

  if (!root) {
    log.info("CONCORDIA_ERROR_WATCH_LOGS_ROOT unset; vestigium error watch disabled");
    return { stop: () => {}, runOnce: async () => {} };
  }

  // service code -> 最後に転記した ts (ms). 初回観測時に now で初期化して履歴を捨てる.
  const watermark = new Map<string, number>();

  async function runOnce(): Promise<void> {
    let services: string[];
    try {
      services = await listVestigiumServices(root!);
    } catch (e) {
      log.warn(`listVestigiumServices failed: ${(e as Error).message}`);
      return;
    }
    const now = Date.now();
    for (const service of services) {
      const logPath = `${root}/${service}`;
      const last = watermark.get(service);
      if (last === undefined) {
        // 初回はダンプしない. 現時点を基準に据える.
        watermark.set(service, now);
        continue;
      }
      let recs;
      try {
        recs = await recent({ logPath, limit: 200, level: ["error", "fatal"], since: last + 1 });
      } catch (e) {
        log.warn(`recent(${service}) failed: ${(e as Error).message}`);
        continue;
      }
      let maxTs = last;
      // recent は新しい順なので古い順に転記したい → reverse.
      for (const rec of [...recs].reverse()) {
        if (rec.ts <= last) continue;
        reportError(`vestigium:${rec.service}`, rec.msg, rec.ctx);
        if (rec.ts > maxTs) maxTs = rec.ts;
      }
      watermark.set(service, maxTs);
    }
  }

  log.info(`vestigium error watch enabled root=${root} interval=${intervalSec}s`);
  const timer = setInterval(() => { void runOnce(); }, intervalSec * 1000);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
