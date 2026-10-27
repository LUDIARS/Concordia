/**
 * 拠点ロールで、 ローカル Claude/Codex の週間使用量を本社へ定期送信する (SPEC-FED-SITE-USAGE)。
 *
 * 本社はそれを本社のコストチャンネルに拠点別で出す (2026-10-27 指示)。 本社は拠点ごとに
 * 後着で上書きするので、 送信が欠けても次の周期で追いつく。 拠点ロールかどうかは周期ごとに見る。
 *
 * @implements spec/feature/federation-link.md SPEC-FED-SITE-USAGE
 */
import type { SiteUsageReport } from "./site-usage.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("federation/site-usage");
/** コストチャンネルの更新間隔より粗くてよい (週間の値なので 15 分の遅れは問題にならない)。 */
export const SITE_USAGE_INTERVAL_MS = 15 * 60 * 1000;

export interface SiteUsageReporterDeps {
  isSiteRole: () => boolean;
  collect: (nowSec: number) => Promise<SiteUsageReport>;
  send: (report: SiteUsageReport) => boolean;
  now?: () => Date;
}

/** 1 周期分: 拠点ロールなら週間使用量を送る。 送れたら true。 */
export async function reportSiteUsageOnce(deps: SiteUsageReporterDeps): Promise<boolean> {
  if (!deps.isSiteRole()) return false;
  const nowSec = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const report = await deps.collect(nowSec);
  if (deps.send(report)) return true;
  log.info("site usage report not sent (HQ link down); retry next tick");
  return false;
}

export function startSiteUsageReporter(deps: SiteUsageReporterDeps): { stop(): void } {
  const supervised = startSupervisedInterval("site-usage-reporter", async () => {
    await reportSiteUsageOnce(deps);
  }, {
    intervalMs: SITE_USAGE_INTERVAL_MS,
    initialDelayMs: 90_000,
    log: { warn: (message) => log.warn(message) },
  });
  return { stop: () => supervised.stop() };
}
