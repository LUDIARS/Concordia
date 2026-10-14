/**
 * 拠点ロールで、 その日の作業記録を本社へ定期送信する (SPEC-FED-SITE-ACTIVITY)。
 *
 * 日報は本社だけが作るので (2026-10-14 neco 指示)、 拠点は今日・昨日のセッションを送り直し続ける。
 * 本社は同じ拠点・日付を後着で上書きするため、 送信が欠けても次の周期で追いつく。
 * 拠点ロールかどうかは周期ごとに見る (連合の設定は再起動なしで変わる)。
 * 各セッションには、 そのセッションが提出した PR を載せる (2026-10-14 neco「拠点から送る記録に PR を含めます」)。
 */
import { dayRange } from "../daily/aggregator.js";
import { buildSiteDayActivity, type SiteDayActivity } from "../daily/site-activity.js";
import type { FederationActivityPr } from "./protocol.js";
import type { SessionRow } from "../shared/types.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("federation/site-activity");
export const SITE_ACTIVITY_INTERVAL_MS = 30 * 60 * 1000;

export interface SiteActivityReporterDeps {
  isSiteRole: () => boolean;
  listSessionsInRange: (startTs: number, endTs: number) => SessionRow[];
  /** セッションごとの提出 PR。 未注入・失敗のときは PR なしで送る (記録の送信は止めない)。 */
  listSessionPrs?: (sessionIds: readonly string[]) => Promise<Map<string, FederationActivityPr[]>>;
  send: (report: SiteDayActivity) => boolean;
  now?: () => Date;
}

async function sessionPrsOf(deps: SiteActivityReporterDeps, sessionIds: readonly string[]): Promise<Map<string, FederationActivityPr[]>> {
  if (!deps.listSessionPrs || sessionIds.length === 0) return new Map();
  try {
    return await deps.listSessionPrs(sessionIds);
  } catch (e) {
    log.warn({ err: (e as Error).message }, "site activity PR lookup failed; sending sessions without PRs");
    return new Map();
  }
}

/** 1 周期分: 拠点ロールなら今日と昨日の記録を送る。 送れた日付を返す (テスト用)。 */
export async function reportSiteActivityOnce(deps: SiteActivityReporterDeps): Promise<string[]> {
  if (!deps.isSiteRole()) return [];
  const now = deps.now?.() ?? new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const days = [dayRange(now), dayRange(yesterday)].map((day) => ({ day, sessions: deps.listSessionsInRange(day.startTs, day.endTs) }));
  const prs = await sessionPrsOf(deps, days.flatMap(({ sessions }) => sessions.map((s) => s.id)));
  const sent: string[] = [];
  for (const { day, sessions } of days) {
    const report = buildSiteDayActivity(
      day.iso,
      sessions,
      Math.floor(now.getTime() / 1000),
      undefined,
      (sessionId) => prs.get(sessionId) ?? [],
    );
    if (deps.send(report)) sent.push(day.iso);
    else log.info({ date: day.iso }, "site activity report not sent (HQ link down); retry next tick");
  }
  return sent;
}

export function startSiteActivityReporter(deps: SiteActivityReporterDeps): { stop(): void } {
  const supervised = startSupervisedInterval("site-activity-reporter", async () => {
    await reportSiteActivityOnce(deps);
  }, {
    intervalMs: SITE_ACTIVITY_INTERVAL_MS,
    initialDelayMs: 60_000,
    log: { warn: (message) => log.warn(message) },
  });
  return { stop: () => supervised.stop() };
}
