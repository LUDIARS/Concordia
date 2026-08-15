// セッション終了時のチームコスト報告 (spec/feature/teams.md §2 コスト面)。
//
// 「チーム内で行ったセッションのコストを計算して報告する。報告はセッション終了時で
// よい」 (neco 2026-08-15) の実体。 新しい集計正本は作らず、 cost_usage_samples の
// 既存 read model (team-metrics-repo) を畳んだ結果を出すだけ。
//
// ここは文面の組み立てだけを行う純関数で、 Discord も DB も触らない。

export interface TeamCostReportInput {
  teamName: string;
  /** 終了したセッションの表示名 (task / provider など呼び出し側が決める)。 */
  sessionLabel: string;
  /** そのセッション 1 本の消費トークン。 */
  sessionCostTokens: number;
  /** 当日のチーム合計 (このセッション分を含む)。 */
  teamTodayCostTokens: number;
  /** 当日に終了・稼働したセッション数。 分母が分かると 1 本の重みが読める。 */
  teamTodaySessionCount: number;
}

/**
 * 報告カードの本文。 チームの「コスト」チャンネルへ 1 セッション 1 通で投稿する。
 * 0 トークンでも投稿する — 「動いたのに費用が出ない」を異常として見せたいため。
 */
export function renderTeamCostReport(input: TeamCostReportInput): string {
  const share = input.teamTodayCostTokens > 0
    ? Math.round((input.sessionCostTokens / input.teamTodayCostTokens) * 100)
    : 0;
  return [
    `**${input.teamName}** セッション終了`,
    `- セッション: ${input.sessionLabel}`,
    `- このセッション: ${formatTokens(input.sessionCostTokens)}`,
    `- 本日のチーム累計: ${formatTokens(input.teamTodayCostTokens)}`
      + ` (${input.teamTodaySessionCount} セッション、 うち今回 ${share}%)`,
  ].join("\n");
}

/** 桁が大きいので k / M に丸める。 正確な値は WebUI のコストグラフが持つ。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0 tokens";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${Math.round(tokens)} tokens`;
}
