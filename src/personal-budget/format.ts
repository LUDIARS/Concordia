/**
 * 本人へ見せる文面 (純関数)。 `/budget` の応答と、 付与・調整の通知。
 * 文面は本人宛てにだけ使う (CC-PBUDGET-INV-08)。
 *
 * @implements SPEC-PBUDGET-VIEW
 * @implements spec/feature/personal-ai-budget.md §4 / §7
 */

import type { LedgerEntry } from "./ports.js";
import type { BudgetView } from "./view-service.js";

export function formatTokens(tokens: number): string {
  return Math.trunc(tokens).toLocaleString("en-US");
}

const KIND_LABEL: Record<string, string> = {
  bounty: "バグ報告の報奨",
  tabula: "Tabula 公開の報奨",
  manual: "本社の調整",
};

/** 台帳 1 行を人が読める 1 行にする。 */
export function describeLedgerEntry(entry: Pick<LedgerEntry, "entry_type" | "tokens" | "reward_kind" | "reason" | "period">): string {
  const amount = `${entry.tokens >= 0 ? "+" : "-"}${formatTokens(Math.abs(entry.tokens))}`;
  if (entry.entry_type === "debit") return `${amount} 消費 (${entry.period ?? "-"})`;
  const kind = KIND_LABEL[entry.reward_kind ?? ""] ?? "報奨";
  if (entry.entry_type === "revoke") return `${amount} ${kind}の取り消し${entry.reason ? `: ${entry.reason}` : ""}`;
  if (entry.entry_type === "manual") return `${amount} ${kind}${entry.reason ? `: ${entry.reason}` : ""}`;
  return `${amount} ${kind}`;
}

function dateLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** `/budget` の本文。 `companyName` は会社の表示名を引く関数。 */
export function renderBudgetView(views: readonly BudgetView[], companyName: (subsidiaryId: string) => string): string {
  if (views.length === 0) {
    return "個人の AI 予算の記録はまだありません。子会社で依頼を出すか、報奨が付くとここに表示されます (本社メンバーは対象外です)。";
  }
  return views.map((view) => {
    const monthly = view.monthlyLimit > 0
      ? `上限 ${formatTokens(view.monthlyLimit)} / 使用 ${formatTokens(view.monthlyUsed)} / 残り ${formatTokens(view.monthlyRemaining ?? 0)}`
      : `上限なし / 使用 ${formatTokens(view.monthlyUsed)}`;
    const lines = [
      `**${companyName(view.person.subsidiary_id)}** の個人の AI 予算 (${view.period})`,
      `- 月間分: ${monthly}`,
      `- 報酬分の残り: ${formatTokens(view.rewardBalance)}`,
    ];
    if (view.recent.length > 0) {
      lines.push("- 直近の履歴:");
      for (const entry of view.recent) lines.push(`  - ${dateLabel(entry.created_at)} ${describeLedgerEntry(entry)}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

/** 付与・調整・取り消しを本人へ知らせる文面。 debit は知らせない (null)。 */
export function renderLedgerNotice(entry: LedgerEntry, input: { companyName: string; rewardBalance: number }): string | null {
  if (entry.entry_type === "debit") return null;
  return [
    `💰 ${input.companyName} の個人の AI 予算 (報酬分) が変わりました。`,
    describeLedgerEntry(entry),
    `報酬分の残り: ${formatTokens(input.rewardBalance)} トークン。詳細は /budget で確認できます。`,
  ].join("\n");
}
