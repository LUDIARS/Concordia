/**
 * POST /v1/events/playtest-review — Ingenium (`ingenium playtest`) が AI プレイテスト感想を Cc に渡す口。
 * 本文は決めた項目だけ (strict)。 良い点・悪い点はどちらも 1 件以上必須で、 欠けたら 400 (投稿しない)。
 * 宛先は Cc の設定が決める (設定で有効なら Tabula にも載せ、 応答の tabula に結果を返す)。 認証はデプロイ・リリース通知と同じ共有トークン (loopback 運用では省略可)。
 * run の動画を付けるときは multipart/form-data で、 `review` に同じ本文の JSON、 `video` に mp4 を入れる
 * (上限 PLAYTEST_VIDEO_MAX_BYTES、 超えたら 413)。 応答の video に宛先ごとの添付の成否を返す。
 *
 * @implements spec/feature/playtest-review-notify.md — 受け口
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { DeploymentDelivery } from "../deploy/service-deployed.js";
import { handlePlaytestReview, type PlaytestReviewTargets } from "../playtest-review/handle-playtest-review.js";
import { PLAYTEST_ASPECTS } from "../playtest-review/playtest-review-notice.js";
import type { PlaytestReviewLedger } from "../playtest-review/recent-run-ledger.js";
import type { PlaytestReviewTabula } from "../playtest-review/playtest-review-tabula.js";
import { PLAYTEST_VIDEO_MAX_BYTES, type PlaytestReviewVideo, type PlaytestVideoDelivery } from "../playtest-review/playtest-review-video.js";

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

/** multipart の余白 (境界・review 部) を動画の上限に足した本文の上限。 */
const REQUEST_MAX_BYTES = PLAYTEST_VIDEO_MAX_BYTES + 256 * 1024;

type ReadBody = { event: unknown; video?: PlaytestReviewVideo } | { error: "invalid_body" | "invalid_video" };

/** JSON か multipart (review + video) を読む。 */
async function readBody(c: Context): Promise<ReadBody> {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return { event: await c.req.json().catch(() => null) };
  const form = await c.req.parseBody().catch(() => null);
  const review = form?.review;
  const text = review instanceof File ? await review.text() : typeof review === "string" ? review : null;
  if (text === null) return { error: "invalid_body" };
  let event: unknown;
  try { event = JSON.parse(text); } catch { return { error: "invalid_body" }; }
  const video = form?.video;
  if (video === undefined) return { event };
  if (!(video instanceof File) || video.type !== "video/mp4" || video.size === 0 || video.size > PLAYTEST_VIDEO_MAX_BYTES) return { error: "invalid_video" };
  const name = video.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "playtest.mp4";
  return { event, video: { name: name.toLowerCase().endsWith(".mp4") ? name : `${name}.mp4`, bytes: new Uint8Array(await video.arrayBuffer()) } };
}

export function playtestReviewRouter(deps: {
  ledger: PlaytestReviewLedger;
  targets: PlaytestReviewTargets;
  delivery: DeploymentDelivery;
  tabula?: PlaytestReviewTabula;
  videoDelivery?: PlaytestVideoDelivery;
  authorize: (header: string | undefined) => boolean;
  log?: { info: (detail: Record<string, unknown>, message: string) => void; warn: (detail: Record<string, unknown>, message: string) => void };
}): Hono {
  const app = new Hono();
  app.post("/", bodyLimit({ maxSize: REQUEST_MAX_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    if (!deps.authorize(c.req.header("x-excubitor-token"))) return c.json({ error: "unauthorized" }, 401);
    const body = await readBody(c);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const parsed = EventSchema.safeParse(body.event);
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const outcome = await handlePlaytestReview({
      event: parsed.data,
      ledger: deps.ledger,
      targets: deps.targets,
      delivery: deps.delivery,
      ...(deps.tabula ? { tabula: deps.tabula } : {}),
      ...(body.video ? { video: body.video } : {}),
      ...(deps.videoDelivery ? { videoDelivery: deps.videoDelivery } : {}),
    });
    const detail = {
      runId: parsed.data.runId,
      gameId: parsed.data.gameId,
      duplicate: outcome.duplicate,
      unconfigured: outcome.unconfigured,
      delivered: outcome.delivered.map((result) => result.target),
      failed: outcome.failed.map((result) => ({ ...result.target, error: result.error })),
      tabula: outcome.tabula,
      video: outcome.video && { delivered: outcome.video.delivered.map((result) => result.target), failed: outcome.video.failed.map((result) => ({ ...result.target, error: result.error })) },
    };
    if (outcome.failed.length > 0 || (outcome.video?.failed.length ?? 0) > 0 || (outcome.tabula !== null && "error" in outcome.tabula)) deps.log?.warn(detail, "playtest-review delivery failed");
    else deps.log?.info(detail, outcome.unconfigured ? "playtest-review skipped because no destination is configured" : "playtest-review delivery completed");
    return c.json(outcome, outcome.duplicate ? 200 : 202);
  });
  return app;
}
