/**
 * 組織 (本社 / 子会社) 別のトークンコスト集計 (本日 / 週間)。
 *
 * 子会社が起動したセッションは metadata.subsidiary_id でタグ付けされる
 * (api/sessions.ts が pending spawn を claim して焼く)。 指定範囲に始まったセッション群の
 * provider ログ累積トークンを subsidiary_id でグルーピングし、 本社 (= 未タグ) と各子会社の
 * 消費トークンを出す。 Concordia モニターに本社 / 子会社のコストを並べて出すための単一の
 * 集計点 (LUDIARS は API 非課金のため「コスト」 = サブスク消費トークン)。
 *
 * 集計は subsidiary/budget.ts (子会社の予算判定) と同じ「local 範囲 × readSessionUsage」
 * を踏襲し、 本社分も同じ 1 パスで出すので両者の数字がぶれない。 本日 = local 暦日、
 * 週間 = 直近 7 暦日 (今日含む)。 帰属はセッション開始時刻 (listSessionsInRange) で判定する。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { readSessionUsage } from "./log-usage.js";
import { localDateIso } from "./usage-tracker.js";
import { localDayRange, readSubsidiaryId } from "../subsidiary/budget.js";

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
  /** 範囲内の累積トークン。 */
  tokens: number;
  /** 日次予算 (トークン)。 0 = 無制限 (本社は常に 0)。 週間集計では常に 0。 */
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

/** epoch(ms) → 直近 7 暦日 (今日含む) の [00:00(6日前), 翌00:00] の epoch(ms) 範囲。 */
export function localWeekRange(nowMs: number): [number, number] {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return [start, end];
}

/** [start,end) のセッションを 1 パス走査し、 本社 / 各子会社のトークンを集計する (共通コア)。 */
function aggregateOrgCost(
  sessionsRepo: SessionsRepo,
  subsidiaries: OrgCostSubsidiary[],
  start: number,
  end: number,
  label: string,
  withBudget: boolean,
): OrgCostReport {
  const rows = sessionsRepo.listSessionsInRange(start, end);
  const known = new Set(subsidiaries.map((s) => s.id));

  const bySub = new Map<string, number>();
  let headTokens = 0;
  let total = 0;
  for (const s of rows) {
    const usage = readSessionUsage(s);
    const t = usage?.total ?? 0;
    if (t <= 0) continue;
    total += t;
    const sid = readSubsidiaryId(s.metadata);
    if (sid && known.has(sid)) {
      bySub.set(sid, (bySub.get(sid) ?? 0) + t);
    } else if (!sid) {
      headTokens += t;
    }
    // sid があるが known でない (削除済み子会社等) は total のみ反映。
  }

  const subRows: OrgCostRow[] = subsidiaries.map((sub) => {
    const tokens = bySub.get(sub.id) ?? 0;
    // 予算 (blocked) は日次概念なので、 週間集計 (withBudget=false) では出さない。
    const budget = withBudget ? Math.max(0, Math.floor(sub.daily_token_budget || 0)) : 0;
    return { id: sub.id, name: sub.name, tokens, budget, blocked: budget > 0 && tokens >= budget };
  });

  return {
    headOffice: { id: null, name: "本社", tokens: headTokens, budget: 0, blocked: false },
    subsidiaries: subRows,
    totalTokens: total,
    label,
  };
}

/** 当日 (local 暦日) の本社 / 子会社別コスト。 子会社は日次予算 / 超過も持つ。 */
export function collectOrgCost(
  sessionsRepo: SessionsRepo,
  subsidiaries: OrgCostSubsidiary[],
  nowMs: number = Date.now(),
): OrgCostReport {
  const [start, end] = localDayRange(nowMs);
  return aggregateOrgCost(sessionsRepo, subsidiaries, start, end, localDateIso(nowMs), true);
}

/** 週間 (直近 7 暦日) の本社 / 子会社別コスト。 予算概念は無し (tokens のみ)。 */
export function collectOrgCostWeekly(
  sessionsRepo: SessionsRepo,
  subsidiaries: OrgCostSubsidiary[],
  nowMs: number = Date.now(),
): OrgCostReport {
  const [start, end] = localWeekRange(nowMs);
  const label = `${localDateIso(start)}〜${localDateIso(nowMs)}`;
  return aggregateOrgCost(sessionsRepo, subsidiaries, start, end, label, false);
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
 * daily は必須、 weekly を渡すと「本日」「週間」の 2 ブロックを出す。
 * 本社 → 各子会社の順。 日次予算ありは `消費 / 予算`、 超過は ⚠️。
 */
export function renderOrgCostLines(daily: OrgCostReport, weekly?: OrgCostReport): string[] {
  const lines: string[] = [];
  lines.push("### コスト (トークン)");
  lines.push(...renderReportBlock(daily, `**本日 (${daily.label})**`));
  if (weekly) {
    lines.push("");
    lines.push(...renderReportBlock(weekly, `**週間 (${weekly.label})**`));
  }
  return lines;
}
