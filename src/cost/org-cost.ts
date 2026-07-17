/**
 * 組織 (本社 / 子会社) 別のトークンコスト集計 (本日 / 週間、 時間帯集計)。
 *
 * 子会社が起動したセッションは metadata.subsidiary_id でタグ付けされる
 * (api/sessions.ts が pending spawn を claim して焼く)。 直近 7 日に動いた
 * (last_seen_at) セッションを候補に取り、 各セッションの provider JSONL を **時刻で
 * ウィンドウ集計** (windowed-usage) して、 本社 (= 未タグ) と各子会社の「本日 / 週間」
 * 消費トークンを出す。 Concordia モニターに並べて出すための単一の集計点
 * (LUDIARS は API 非課金のため「コスト」 = サブスク消費トークン)。
 *
 * 重要: セッション開始日での按分はしない (日跨ぎの長時間セッションで 0/誤帰属になる)。
 * 各 JSONL エントリのタイムスタンプで本日 / 直近 7 日のウィンドウに入る分だけ数える。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { localDateIso } from "./usage-tracker.js";
import { readSessionWindowedTotals, type SessionWindowReader } from "./windowed-usage.js";

/** コスト行を出す対象子会社の最小フィールド。 */
export interface OrgCostSubsidiary {
  id: string;
  name: string;
  daily_token_budget: number;
}

/** 1 組織 (本社 or 子会社) のコスト行。 */
export interface OrgCostRow {
  /** 子会社 id。 本社は null。 */
  id: string | null;
  /** 表示名。 */
  name: string;
  /** ウィンドウ内の消費トークン。 */
  tokens: number;
  /** 日次予算 (トークン)。 0 = 無制限。 週間集計では常に 0。 */
  budget: number;
  /** 予算超過中か (budget>0 かつ tokens>=budget)。 週間集計では常に false。 */
  blocked: boolean;
}

export interface OrgCostReport {
  /** 本社 (subsidiary_id 無しのセッション合算)。 */
  headOffice: OrgCostRow;
  /** 各子会社 (引数で渡した順)。 */
  subsidiaries: OrgCostRow[];
  /** 本社 + 全子会社の合計トークン。 */
  totalTokens: number;
  /** 集計対象を表すラベル ("YYYY-MM-DD" / "YYYY-MM-DD〜YYYY-MM-DD")。 */
  label: string;
}

export interface OrgCostWindows {
  daily: OrgCostReport;
  weekly: OrgCostReport;
}

export interface OrgCostProfileEvent {
  sessionId: string;
  provider: string;
  repoPath: string;
  ms: number;
  dailyTokens: number;
  weeklyTokens: number;
}

export interface OrgCostProfile {
  sessions: number;
  readMs: number;
  slowReads: OrgCostProfileEvent[];
}

export interface OrgCostOptions {
  slowReadMs?: number;
  onProfile?: (profile: OrgCostProfile) => void;
}

/** epoch(ms) → その local 暦日 00:00 の epoch 秒。 */
function localMidnightSec(nowMs: number): number {
  const d = new Date(nowMs);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
}

/** epoch(ms) → 直近 7 暦日 (今日含む) の開始 00:00(6日前) の epoch 秒。 */
function localWeekStartSec(nowMs: number): number {
  const d = new Date(nowMs);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime() / 1000);
}

/**
 * 本社 / 子会社別の本日・週間コストを JSONL 時間帯集計で出す。
 * reader はテスト差し替え用 (既定は実 JSONL を読む readSessionWindowedTotals)。
 */
export async function collectOrgCostWindows(
  sessionsRepo: SessionsRepo,
  subsidiaries: OrgCostSubsidiary[],
  nowMs: number = Date.now(),
  reader: SessionWindowReader = readSessionWindowedTotals,
  options: OrgCostOptions = {},
): Promise<OrgCostWindows> {
  const nowSec = Math.floor(nowMs / 1000);
  const todayStartSec = localMidnightSec(nowMs);
  const weekStartSec = localWeekStartSec(nowMs);
  // endSec は now を含めるため +1 (半開区間 [start, end))。
  const windows = [
    { key: "d", startSec: todayStartSec, endSec: nowSec + 1 },
    { key: "w", startSec: weekStartSec, endSec: nowSec + 1 },
  ];

  const sessions = sessionsRepo.listSessionsSeenSince(weekStartSec);
  const known = new Set(subsidiaries.map((s) => s.id));
  const slowReadMs = options.slowReadMs ?? 250;
  const profile: OrgCostProfile = { sessions: sessions.length, readMs: 0, slowReads: [] };

  const dailyBySub = new Map<string, number>();
  const weeklyBySub = new Map<string, number>();
  let dailyHead = 0, weeklyHead = 0, dailyTotal = 0, weeklyTotal = 0;

  for (const s of sessions) {
    const readStarted = Date.now();
    const t = await reader(s, windows);
    const readMs = Date.now() - readStarted;
    profile.readMs += readMs;
    const dd = t.d ?? 0;
    const ww = t.w ?? 0;
    if (readMs >= slowReadMs) {
      profile.slowReads.push({
        sessionId: s.id,
        provider: s.provider,
        repoPath: s.repo_path,
        ms: readMs,
        dailyTokens: dd,
        weeklyTokens: ww,
      });
    }
    if (dd <= 0 && ww <= 0) continue;
    dailyTotal += dd;
    weeklyTotal += ww;
    const sid = readSubsidiaryId(s.metadata);
    if (sid && known.has(sid)) {
      dailyBySub.set(sid, (dailyBySub.get(sid) ?? 0) + dd);
      weeklyBySub.set(sid, (weeklyBySub.get(sid) ?? 0) + ww);
    } else if (!sid) {
      dailyHead += dd;
      weeklyHead += ww;
    }
    // sid があるが known でない (削除済み子会社等) は total のみ反映。
  }

  profile.slowReads.sort((a, b) => b.ms - a.ms);
  options.onProfile?.(profile);

  const buildSubs = (m: Map<string, number>, withBudget: boolean): OrgCostRow[] =>
    subsidiaries.map((sub) => {
      const tokens = m.get(sub.id) ?? 0;
      const budget = withBudget ? Math.max(0, Math.floor(sub.daily_token_budget || 0)) : 0;
      return { id: sub.id, name: sub.name, tokens, budget, blocked: budget > 0 && tokens >= budget };
    });

  const daily: OrgCostReport = {
    headOffice: { id: null, name: "本社", tokens: dailyHead, budget: 0, blocked: false },
    subsidiaries: buildSubs(dailyBySub, true),
    totalTokens: dailyTotal,
    label: localDateIso(nowMs),
  };
  const weekly: OrgCostReport = {
    headOffice: { id: null, name: "本社", tokens: weeklyHead, budget: 0, blocked: false },
    subsidiaries: buildSubs(weeklyBySub, false),
    totalTokens: weeklyTotal,
    label: `${localDateIso(weekStartSec * 1000)}〜${localDateIso(nowMs)}`,
  };
  return { daily, weekly };
}

/** トークン数を人が読みやすく整形 (1,234,567 / 12k 系ではなくフル桁)。 */
export function fmtTokens(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(n)));
}

/** 1 レポートの組織行を描く (見出し + 本社 + 子会社 + 合計)。 */
function renderReportBlock(report: OrgCostReport, heading: string): string[] {
  const lines: string[] = [];
  lines.push(heading);
  lines.push(`- 🏠 本社: ${fmtTokens(report.headOffice.tokens)}`);
  for (const r of report.subsidiaries) {
    const budgetPart = r.budget > 0 ? ` / ${fmtTokens(r.budget)}` : "";
    lines.push(`- 🏢 ${r.name}: ${fmtTokens(r.tokens)}${budgetPart}${r.blocked ? " ⚠️予算超過" : ""}`);
  }
  lines.push(`- 合計: ${fmtTokens(report.totalTokens)}`);
  return lines;
}

/**
 * 本社/子会社別コストを Concordia モニター用の markdown 行配列に描く。
 * 「本日」「週間」の 2 ブロック。 本社 → 各子会社の順。 日次予算ありは `消費 / 予算`、 超過は ⚠️。
 */
export function renderOrgCostLines(windows: OrgCostWindows): string[] {
  const lines: string[] = [];
  lines.push("### コスト (トークン)");
  lines.push(...renderReportBlock(windows.daily, `**本日 (${windows.daily.label})**`));
  lines.push("");
  lines.push(...renderReportBlock(windows.weekly, `**週間 (${windows.weekly.label})**`));
  return lines;
}
