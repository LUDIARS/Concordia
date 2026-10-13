/**
 * 拠点ロールで、 その日の作業記録を本社へ定期送信する (SPEC-FED-SITE-ACTIVITY)。
 *
 * 日報は本社だけが作るので (2026-10-14 neco 指示)、 拠点は今日・昨日のセッションを送り直し続ける。
 * 本社は同じ拠点・日付を後着で上書きするため、 送信が欠けても次の周期で追いつく。
 * 拠点ロールかどうかは周期ごとに見る (連合の設定は再起動なしで変わる)。
 */
import { dayRange } from "../daily/aggregator.js";
import { buildSiteDayActivity, type SiteDayActivity } from "../daily/site-activity.js";
import type { SessionRow } from "../shared/types.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("federation/site-activity");
export const SITE_ACTIVITY_INTERVAL_MS = 30 * 60 * 1000;

export interface SiteActivityReporterDeps {
  isSiteRole: () => boolean;
  listSessionsInRange: (startTs: number, endTs: number) => SessionRow[];
  send: (report: SiteDayActivity) => boolean;
  now?: () => Date;
}

/** 1 周期分: 拠点ロールなら今日と昨日の記録を送る。 送れた日付を返す (テスト用)。 */
export function reportSiteActivityOnce(deps: SiteActivityReporterDeps): string[] {
  if (!deps.isSiteRole()) return [];
  const now = deps.now?.() ?? new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sent: string[] = [];
  for (const day of [dayRange(now), dayRange(yesterday)]) {
    const report = buildSiteDayActivity(day.iso, deps.listSessionsInRange(day.startTs, day.endTs), Math.floor(now.getTime() / 1000));
    if (deps.send(report)) sent.push(day.iso);
    else log.info({ date: day.iso }, "site activity report not sent (HQ link down); retry next tick");
  }
  return sent;
}

export function startSiteActivityReporter(deps: SiteActivityReporterDeps): { stop(): void } {
  const supervised = startSupervisedInterval("site-activity-reporter", async () => {
    reportSiteActivityOnce(deps);
  }, {
    intervalMs: SITE_ACTIVITY_INTERVAL_MS,
    initialDelayMs: 60_000,
    log: { warn: (message) => log.warn(message) },
  });
  return { stop: () => supervised.stop() };
}
