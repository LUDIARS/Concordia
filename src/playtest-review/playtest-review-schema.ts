/**
 * AI プレイテスト感想の本文スキーマ (受け口と Muse の結果の中継で共用)。
 * 決めた項目だけ (strict)。 良い点・悪い点はどちらも 1 件以上必須 (CC-PLAYTEST-INV-03 / CC-MUSE-RELAY-INV-02)。
 *
 * @implements spec/feature/playtest-review-notify.md — 受け口
 */

import { z } from "zod";
import { PLAYTEST_ASPECTS } from "./playtest-review-notice.js";

const Point = z.object({ aspect: z.enum(PLAYTEST_ASPECTS), text: z.string().trim().min(1).max(300) }).strict();
const Text = (max: number) => z.string().trim().min(1).max(max);

const ReviewFields = {
  runId: Text(200),
  gameId: Text(200),
  gameTitle: Text(200),
  persona: Text(200),
  screen: z.enum(["image", "text"]),
  ticks: z.number().int().min(0),
  turns: z.number().int().min(0),
  outcome: Text(200),
  summary: Text(400),
  good: z.array(Point).min(1).max(8),
  bad: z.array(Point).min(1).max(8),
  confusions: z.array(Point).max(8),
  reflection: z.array(Text(300)).min(1).max(8),
};

/** `POST /v1/events/playtest-review` の本文。 */
export const PlaytestReviewEventSchema = z.object({ ...ReviewFields, voluptasId: Text(200).nullable() }).strict();

/** Muse の playtest の result の `detail.review`。 記録 ID は Cc が保存してから付けるので持たない。 */
export const MusePlaytestReviewSchema = z.object(ReviewFields).strict();
export type MusePlaytestReview = z.infer<typeof MusePlaytestReviewSchema>;
