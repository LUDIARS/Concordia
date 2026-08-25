/**
 * チーム面カード種別の正本 (spec/feature/director-workflow.md §3)。
 *
 * API 受付 (api/teams.ts の zod) / event 契約 (events.ts, shared/event-schema.ts) /
 * Discord ルーティング (discord/team-card-routing.ts) が同じ literal を手書きで
 * 繰り返すと、種別追加時に 1 箇所だけ漏れてもコンパイルが通ってしまう
 * (実際に task-kanban 追加で event-schema だけ漏れた)。ここから導出して漏れを型で検出する。
 */

/** POST /v1/teams/:id/cards が受け付ける種別 (delegation からの報告カード)。 */
export const TEAM_CARD_POST_KINDS = ["standup", "meeting", "task-kanban", "issue-hypothesis"] as const;

export type TeamCardPostKind = (typeof TEAM_CARD_POST_KINDS)[number];

/**
 * event `team.card_requested` が運べる種別 = POST 可能種別 + Cc 内部 emit 専用の
 * question (Director 巡回の人間エスカレーション。API からは投げられない)。
 */
export const TEAM_CARD_EVENT_KINDS = [...TEAM_CARD_POST_KINDS, "question"] as const;

export type TeamCardEventKind = (typeof TEAM_CARD_EVENT_KINDS)[number];
