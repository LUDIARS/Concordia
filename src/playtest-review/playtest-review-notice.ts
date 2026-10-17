/**
 * AI プレイテスト感想 (Ingenium `ingenium playtest` の ai-playtest-review/1) を人が読む投稿文にする。
 * 宛先・保存・設定に依存しない純関数。 良い点と悪い点は受け口で必須にしてあるので (CC-PLAYTEST-INV-03)、
 * ここでは並べるだけ。 本文は LLM が書いた文なので、 mention は配送側 (allowed_mentions /
 * sanitizeSlackMentions) で無効化する (CC-PLAYTEST-INV-04)。
 *
 * @implements spec/feature/playtest-review-notify.md — 投稿文
 */

export const PLAYTEST_ASPECTS = ["ux", "control", "game"] as const;
export type PlaytestAspect = (typeof PLAYTEST_ASPECTS)[number];

export interface PlaytestReviewPoint {
  aspect: PlaytestAspect;
  text: string;
}

export interface PlaytestReviewEvent {
  runId: string;
  gameId: string;
  gameTitle: string;
  persona: string;
  screen: "image" | "text";
  ticks: number;
  turns: number;
  outcome: string;
  summary: string;
  good: PlaytestReviewPoint[];
  bad: PlaytestReviewPoint[];
  confusions: PlaytestReviewPoint[];
  reflection: string[];
  /** Voluptas に保存した記録の ID (保存できなかったときは null)。 */
  voluptasId: string | null;
}

/** Discord の 1 投稿の上限。 Slack (webhook) もこの長さに揃える。 */
export const PLAYTEST_NOTICE_LIMIT = 2000;

const ASPECT_LABEL: Record<PlaytestAspect, string> = { ux: "UX", control: "操作感", game: "ゲーム" };

function points(items: readonly PlaytestReviewPoint[]): string[] {
  return items.map((item) => `・[${ASPECT_LABEL[item.aspect]}] ${item.text.trim()}`);
}

export function composePlaytestReviewNotice(event: PlaytestReviewEvent): string {
  const lines = [
    `🎮 AI プレイテスト: ${event.gameTitle.trim()}`,
    `遊び方: ${event.persona} / 画面: ${event.screen === "image" ? "スクリーンショット" : "文字情報"} / ${event.turns} 回判断・${event.ticks} tick / 結果: ${event.outcome}`,
    "",
    event.summary.trim(),
    "",
    "👍 良い点",
    ...points(event.good),
    "",
    "👎 悪い点",
    ...points(event.bad),
    ...(event.confusions.length === 0 ? [] : ["", "❓ 迷ったところ", ...points(event.confusions)]),
    "",
    "🔁 AI の反省",
    ...event.reflection.map((line) => `・${line.trim()}`),
    ...(event.voluptasId ? ["", `Voluptas 記録: ${event.voluptasId}`] : []),
  ];
  const text = lines.join("\n");
  return text.length > PLAYTEST_NOTICE_LIMIT ? `${text.slice(0, PLAYTEST_NOTICE_LIMIT - 1)}…` : text;
}
