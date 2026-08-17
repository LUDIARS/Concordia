// 既存カード類の投稿先を team_surfaces のチーム面へ切り替えるルーティング決定
// (spec/feature/teams.md §2 / spec/tasks/2026-08-14-team-surface-card-routing.md)。
//
// - team_id が確定していて、 対応する surface がプロビジョニング済みなら、 その
//   channel_id を返す。
// - チーム未設定 (team_id null) / surface 未プロビジョニングなら null を返し、
//   呼び出し側が現行チャンネル (セッション webhook / セッションチャンネル) へ
//   フォールバックする。 ここでは投稿しない — 決定だけを返す純関数。

/**
 * ルーティング対象のカード種別。 surface 名は team-provision.ts が team_surfaces に
 * 保存するキーと一致させる。 cost-daily / task-kanban はチーム面側の張り替え先として
 * 予約済みだが、 投稿元カードが未実装のため呼び出しサイトはまだ無い。
 */
export type TeamCardKind =
  | "director-plan"
  | "decision-log"
  | "question"
  | "cost-daily"
  | "cost-session"
  | "task-kanban"
  | "standup"
  | "meeting";

export const TEAM_CARD_SURFACE: Record<TeamCardKind, string> = {
  "director-plan": "目標",
  "decision-log": "direction",
  "question": "direction",
  "cost-daily": "コスト",
  // セッション終了時の 1 本分の実績。 日次サマリ (cost-daily) と同じ面に出す。
  "cost-session": "コスト",
  "task-kanban": "タスクボード",
  // 朝礼は目標の進み方を報告するので、 director-plan と同じ 目標 面に出す。
  "standup": "目標",
  // 定例の開始通知。 本体の議論は定例セッションの thread で行い、 ここには入口だけ置く。
  "meeting": "direction",
};

export interface TeamSurfaceSource {
  surfaceChannelId(teamId: string, surface: string): string | null;
}

/**
 * カード種別と team_id から投稿先チャンネルを決める。
 * null = チーム面へは送らない (現行チャンネルへフォールバック)。
 */
export function resolveTeamCardChannel(
  source: TeamSurfaceSource,
  teamId: string | null | undefined,
  kind: TeamCardKind,
): string | null {
  if (!teamId) return null;
  return source.surfaceChannelId(teamId, TEAM_CARD_SURFACE[kind]);
}
