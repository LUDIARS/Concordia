/**
 * 日のまとめを組み立てる (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 8. 4:00 の締切と日のまとめ / CC-DG-INV-03 / CC-DG-INV-10
 *
 * まとめは Cc が集めた証跡と確認記録から作る。 セッションの自己申告は「報告」として区別して載せる。
 * 目標なしの日・ゴールも下書きも無い日は null (記載しない)。 ゴールが無く下書きだけの日は
 * 下書きの一覧だけのまとめにする。
 */

import { POST_FIELD_LABELS, type DailyGoal, type DailyGoalDraft, type EvidenceItem } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:ce1b276b */
import augurContract_bde6182b from './day-summary.contract.js'; /* augur-inject:contract-predicate:a5771f45 */

export interface SummaryGoalInput {
  goal: DailyGoal;
  /** 最後の確認・締切停止で Cc が集めた証跡。 */
  evidence: readonly EvidenceItem[];
  /** セッションの最後の報告 (自己申告)。 */
  lastReport: string | null;
}

export interface DaySummaryInput {
  date: string;
  goals: readonly SummaryGoalInput[];
  drafts: readonly DailyGoalDraft[];
  noGoal: boolean;
}

export interface DaySummary { title: string; markdown: string }

export const RESULT_LABELS: Record<DailyGoal["status"], string> = {
  achieved: "達成",
  exhausted: "やり切り",
  stopped: "停止",
  deadline: "締切",
  lost: "喪失",
  confirmed: "起動前",
  running: "継続中",
};

export function daySummaryTitle(date: string): string { return `デイリーゴール ${date}`; }

function acceptanceLines(goal: DailyGoal): string[] {
  return goal.acceptance.map((item) => {
    const refs = goal.acceptanceProgress?.[item] ?? [];
    const reached = goal.status === "achieved" || refs.length > 0;
    return `- ${reached ? "✅ 到達" : "⬜ 未到達"}: ${item}${refs.length ? ` (${refs.join(", ")})` : ""}`;
  });
}

function remainingLines(goal: DailyGoal): string[] {
  return (goal.remaining ?? []).map((item) => item.class === "unachievable"
    ? `- 達成不能: ${item.item} — ${item.reason}`
    : item.class === "human_judgment" ? `- 人間に決めてほしい点: ${item.item}` : `- 残り: ${item.item}`);
}

function goalSection(input: SummaryGoalInput): string[] {
  const { goal } = input;
  const unreached = goal.status === "achieved" ? [] : goal.acceptance.filter((item) => !(goal.acceptanceProgress?.[item]?.length));
  return [
    `### ${goal.project} — ${goal.goalText}`,
    `- 結果: **${RESULT_LABELS[goal.status]}**`,
    "#### 受入条件",
    ...acceptanceLines(goal),
    "#### 証跡 (Cc が確認したもの)",
    ...(input.evidence.length ? input.evidence.slice(-15).map((item) => `- ${item.summary} (\`${item.key}\`)`) : ["- なし"]),
    ...(goal.actioTaskIds.length ? [`- Actio task: ${goal.actioTaskIds.map((id) => `actio:${id}`).join(", ")}`] : []),
    "#### 報告 (セッションの自己申告)",
    input.lastReport ? `> ${input.lastReport.replace(/\n/g, "\n> ")}` : "- なし",
    "#### 残り",
    ...[...remainingLines(goal), ...unreached.map((item) => `- 未到達の受入条件: ${item}`)],
    ...(remainingLines(goal).length || unreached.length ? [] : ["- なし"]),
  ];
}

function draftSection(drafts: readonly DailyGoalDraft[]): string[] {
  return [
    "## 未定義のまま締切 (登録されなかった投稿)",
    ...drafts.map((draft) => {
      const head = (draft.textParts[0] ?? "").replace(/\s+/g, " ").slice(0, 120);
      return `- 「${head}」 — 足りなかった項目: ${draft.missing.map((field) => POST_FIELD_LABELS[field]).join(" / ") || "(不明)"}`;
    }),
  ];
}

export function buildDaySummary(input: DaySummaryInput): DaySummary | null {
  if (input.goals.length === 0 && (input.noGoal || input.drafts.length === 0)) return null;
  const title = daySummaryTitle(input.date);
  if (input.goals.length === 0) {
    return { title, markdown: [`# ${title}`, "ゴールは登録されませんでした。", "", ...draftSection(input.drafts)].join("\n") };
  }
  const counts = new Map<string, number>();
  for (const { goal } of input.goals) counts.set(RESULT_LABELS[goal.status], (counts.get(RESULT_LABELS[goal.status]) ?? 0) + 1);
  const merged = [...new Set(input.goals.flatMap(({ evidence }) => evidence.filter((item) => item.kind === "pr" && item.key.endsWith(":merged"))
    .map((item) => `- ${item.summary} (\`${item.key}\`)`)))];
  const markdown = [
    `# ${title}`,
    `- ゴール: ${input.goals.length} 件 (${[...counts].map(([label, n]) => `${label} ${n}`).join(" / ")})`,
    "## マージされた PR",
    ...(merged.length ? merged : ["- なし"]),
    "## ゴールごとの結果",
    ...input.goals.flatMap((goal) => [...goalSection(goal), ""]),
    ...(input.drafts.length ? draftSection(input.drafts) : []),
  ].join("\n").trim();
  return { title, markdown };
}
// @ts-expect-error augur-inject
buildDaySummary = contract(buildDaySummary, { ...augurContract_bde6182b, contractId: 'dg-C-9', mode: 'observe', sample: 1, where: 'src/daily-goal-run/day-summary.ts:85', rule: 'contract-wrap', id: 'bde6182b' }); /* augur-inject:contract-wrap:bde6182b */
