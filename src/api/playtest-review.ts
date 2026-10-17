/**
 * POST /v1/events/playtest-review — Ingenium (`ingenium playtest`) が AI プレイテスト感想を Cc に渡す口。
 * 本文は決めた項目だけ (strict)。 良い点・悪い点はどちらも 1 件以上必須で、 欠けたら 400 (投稿しない)。
 * 宛先は Cc の設定が決める (設定で有効なら Tabula にも載せ、 応答の tabula に結果を返す)。 認証はデプロイ・リリース通知と同じ共有トークン (loopback 運用では省略可)。
 *
 * @implements spec/feature/playtest-review-notify.md — 受け口
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DeploymentDelivery } from "../deploy/service-deployed.js";
import { handlePlaytestReview, type PlaytestReviewTargets } from "../playtest-review/handle-playtest-review.js";
import { PLAYTEST_ASPECTS } from "../playtest-review/playtest-review-notice.js";
import type { PlaytestReviewLedger } from "../playtest-review/recent-run-ledger.js";
import type { PlaytestReviewTabula } from "../playtest-review/playtest-review-tabula.js";

const Point = z.object({ aspect: z.enum(PLAYTEST_ASPECTS), text: z.string().trim().min(1).max(300) }).strict();
const Text = (max: number) => z.string().trim().min(1).max(max);

const EventSchema = z.object({
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
  voluptasId: Text(200).nullable(),
}).strict();

export function playtestReviewRouter(deps: {
  ledger: PlaytestReviewLedger;
  targets: PlaytestReviewTargets;
  delivery: DeploymentDelivery;
  tabula?: PlaytestReviewTabula;
  authorize: (header: string | undefined) => boolean;
  log?: { info: (detail: Record<string, unknown>, message: string) => void; warn: (detail: Record<string, unknown>, message: string) => void };
}): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    if (!deps.authorize(c.req.header("x-excubitor-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = EventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const outcome = await handlePlaytestReview({ event: parsed.data, ledger: deps.ledger, targets: deps.targets, delivery: deps.delivery, ...(deps.tabula ? { tabula: deps.tabula } : {}) });
    const detail = {
      runId: parsed.data.runId,
      gameId: parsed.data.gameId,
      duplicate: outcome.duplicate,
      unconfigured: outcome.unconfigured,
      delivered: outcome.delivered.map((result) => result.target),
      failed: outcome.failed.map((result) => ({ ...result.target, error: result.error })),
      tabula: outcome.tabula,
    };
    if (outcome.failed.length > 0 || (outcome.tabula !== null && "error" in outcome.tabula)) deps.log?.warn(detail, "playtest-review delivery failed");
    else deps.log?.info(detail, outcome.unconfigured ? "playtest-review skipped because no destination is configured" : "playtest-review delivery completed");
    return c.json(outcome, outcome.duplicate ? 200 : 202);
  });
  return app;
}
