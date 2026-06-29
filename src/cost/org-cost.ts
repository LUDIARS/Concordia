/**
 * 組織 (本社 / 子会社) 別の当日トークンコスト集計。
 *
 * 子会社が起動したセッションは metadata.subsidiary_id でタグ付けされる
 * (api/sessions.ts が pending spawn を claim して焼く)。 当日 (local "YYYY-MM-DD") に
 * 始まったセッション群の provider ログ累積トークンを subsidiary_id でグルーピングし、
 * 本社 (= 未タグ) と各子会社の「本日の消費トークン」を出す。 Concordia モニターに
 * 本社 / 子会社のコストを並べて出すための単一の集計点 (LUDIARS は API 非課金のため
 * 「コスト」 = サブスク消費トークン)。
 *
 * 集計は subsidiary/budget.ts (子会社の予算判定) と同じ「当日 local 範囲 × readSessionUsage」
 * を踏襲し、 本社分も同じ 1 パスで出すので両者の数字がぶれない。
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
  /** 当日 (local) の累積トークン。 */
  tokens: number;
  /** 日次予算 (トークン)。 0 = 無制限 (本社は常に 0)。 */
  budget: number;
  /** 予算超過中か (budget>0 かつ tokens>=budget)。 */
  blocked: boolean;
}

export interface OrgCostReport {
  /** 本社 (subsidiary_id 無しのセッション合算)。 */
  headOffice: OrgCostRow;
  /** 各子会社 (引数で渡した順)。 */
  subsidiaries: OrgCostRow[];
  /** 本社 + 全子会社の合計トークン (当日)。 */
  totalTokens: number;
  /** 集計対象の日付 (local "YYYY-MM-DD")。 */
  dateIso: string;
}

/**
 * 当日のセッションを 1 パス走査し、 本社 / 各子会社のトークンを集計する。
 * 引数の subsidiaries に無い subsidiary_id のセッションは headOffice には入れず
 * (帰属不明として) 合計のみ反映する — 既知の本社/子会社を素直に並べるための割り切り。
 */
export function collectOrgCost(
  sessionsRepo: SessionsRepo,
  subsidiaries: OrgCostSubsidiary[],
  nowMs: number = Date.now(),
): OrgCostReport {
  const [start, end] = localDayRange(nowMs);
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
    const budget = Math.max(0, Math.floor(sub.daily_token_budget || 0));
    return { id: sub.id, name: sub.name, tokens, budget, blocked: budget > 0 && tokens >= budget };
  });

  return {
    headOffice: { id: null, name: "本社", tokens: headTokens, budget: 0, blocked: false },
    subsidiaries: subRows,
    totalTokens: total,
    dateIso: localDateIso(nowMs),
  };
}

/** トークン数を人が読みやすく整形 (1,234,567 / 12k 系ではなくフル桁。 ∞ は budget=0)。 */
export function fmtTokens(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(n)));
}

/**
 * OrgCostReport を Concordia モニター用の markdown 行配列に描く。
 * 本社 → 各子会社の順。 予算ありは `消費 / 予算`、 超過は ⚠️。
 */
export function renderOrgCostLines(report: OrgCostReport): string[] {
  const lines: string[] = [];
  lines.push(`### コスト (本日 ${report.dateIso} / トークン)`);
  lines.push(`- 🏠 本社: ${fmtTokens(report.headOffice.tokens)}`);
  for (const r of report.subsidiaries) {
    const budgetPart = r.budget > 0 ? ` / ${fmtTokens(r.budget)}` : " / ∞";
    lines.push(`- 🏢 ${r.name}: ${fmtTokens(r.tokens)}${budgetPart}${r.blocked ? " ⚠️予算超過" : ""}`);
  }
  lines.push(`- 合計: ${fmtTokens(report.totalTokens)}`);
  return lines;
}
