/**
 * 拠点のその日の作業記録 (SPEC-FED-SITE-ACTIVITY)。
 *
 * 日報は本社だけが作る (2026-10-14 neco 指示)。 拠点はその日のセッションを本社へ送り、
 * 本社の日報に拠点ごとの欄として載せる。 ここは拠点側の組み立てと本社側の要約を持つ純関数だけ。
 */
import type { SessionRow } from "../shared/types.js";
import {
  ACTIVITY_REPORT_MAX_BYTES,
  ACTIVITY_REPORT_MAX_PRS,
  ACTIVITY_REPORT_MAX_SESSIONS,
  ACTIVITY_SESSION_MAX_PRS,
  type FederationActivityPr,
  type FederationActivitySession,
} from "../federation/protocol.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:6fe04ad2 */
import augurContract_31a41e23 from './site-activity-build.contract.js'; /* augur-inject:contract-predicate:c8a191ea */

export interface SiteDayActivity {
  date_iso: string;
  generated_at: number;
  session_count: number;
  sessions: FederationActivitySession[];
}

/** 本社が受け取った 1 拠点・1 日の記録。 */
export interface SiteActivityEntry {
  site_id: string;
  site_name: string;
  received_at: number;
  report: SiteDayActivity;
}

/** 日報の bullets に載せる拠点ごとの要約。 */
export interface SiteDayBullets {
  site_id: string;
  site_name: string;
  session_count: number;
  total_duration_sec: number;
  repos: string[];
  branches: string[];
  sessions: FederationActivitySession[];
  /** 拠点のセッションが提出した PR (同じ PR は 1 件)。 旧版の拠点からの記録では空。 */
  prs: FederationActivityPr[];
}

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** 1 報告を直列化したときの UTF-8 バイト数 (本社の受信上限と比べる)。 */
export function activityReportBytes(report: SiteDayActivity): number {
  return Buffer.byteLength(JSON.stringify({ v: 1, type: "activity-report", ...report }), "utf8");
}

/**
 * 拠点のセッション行から送る記録を作る。 新しい順に上限まで載せ、 総数は session_count に残す。
 * 拠点の DB 内部の metadata・イベント本文は送らない (題名・場所・状態・時間と、 提出した PR だけ)。
 * PR はセッションごと・報告全体の件数上限まで新しいセッションから載せ、 直列化が上限バイトを超えるときは
 * 古いセッションから落とす (本社の受信上限を超えると連合リンクごと切れるため)。
 */
export function buildSiteDayActivity(
  date_iso: string,
  sessions: readonly SessionRow[],
  nowSec: number = Math.floor(Date.now() / 1000),
  limit: number = ACTIVITY_REPORT_MAX_SESSIONS,
  prsOf: (sessionId: string) => readonly FederationActivityPr[] = () => [],
  maxBytes: number = ACTIVITY_REPORT_MAX_BYTES,
): SiteDayActivity {
  const ordered = [...sessions].sort((a, b) => b.started_at - a.started_at);
  let prBudget = ACTIVITY_REPORT_MAX_PRS;
  const report: SiteDayActivity = {
    date_iso,
    generated_at: nowSec,
    session_count: sessions.length,
    sessions: ordered.slice(0, Math.max(0, limit)).map((s) => {
      const endedAt = s.ended_at ?? s.last_seen_at;
      const prs = prsOf(s.id).slice(0, Math.min(ACTIVITY_SESSION_MAX_PRS, prBudget));
      prBudget -= prs.length;
      return {
        id: s.id.slice(0, 200),
        title: clip(s.current_task, 200),
        repo: clip(s.repo_origin ?? s.repo_path, 300),
        branch: clip(s.branch, 200),
        provider: clip(s.provider, 50) ?? "unknown",
        status: clip(s.status, 30) ?? "unknown",
        started_at: Math.max(0, Math.floor(s.started_at)),
        ended_at: s.ended_at === null ? null : Math.max(0, Math.floor(s.ended_at)),
        duration_sec: Math.max(0, Math.floor(endedAt - s.started_at)),
        ...(prs.length ? { prs: prs.map((pr) => ({ ...pr })) } : {}),
      };
    }),
  };
  while (report.sessions.length > 0 && activityReportBytes(report) > maxBytes) report.sessions.pop();
  return report;
}
// @ts-expect-error augur-inject
buildSiteDayActivity = contract(buildSiteDayActivity, { ...augurContract_31a41e23, contractId: 'site-activity-prs-C-2', mode: 'observe', sample: 1, where: 'src/daily/site-activity.ts:63', rule: 'contract-wrap', id: '31a41e23' }); /* augur-inject:contract-wrap:31a41e23 */

function prKey(pr: FederationActivityPr): string {
  return `${pr.source}:${pr.repo}#${pr.number}`;
}

/** 本社で受け取った記録を日報の拠点欄にする。 拠点名順で並べる。 */
export function summarizeSiteActivity(entries: readonly SiteActivityEntry[]): SiteDayBullets[] {
  return [...entries]
    .sort((a, b) => a.site_name.localeCompare(b.site_name) || a.site_id.localeCompare(b.site_id))
    .map((entry) => {
      const repos = new Set<string>();
      const branches = new Set<string>();
      const prs = new Map<string, FederationActivityPr>();
      let total = 0;
      for (const s of entry.report.sessions) {
        if (s.repo) repos.add(s.repo);
        if (s.branch) branches.add(s.branch);
        total += s.duration_sec;
        // 旧版の拠点は prs を送らない (後方互換)。
        for (const pr of s.prs ?? []) if (!prs.has(prKey(pr))) prs.set(prKey(pr), pr);
      }
      return {
        site_id: entry.site_id,
        site_name: entry.site_name,
        session_count: entry.report.session_count,
        total_duration_sec: total,
        repos: [...repos],
        branches: [...branches],
        sessions: entry.report.sessions,
        prs: [...prs.values()],
      };
    });
}
