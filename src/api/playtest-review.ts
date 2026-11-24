/**
 * POST /v1/events/playtest-review — Ingenium (`ingenium playtest`) が AI プレイテスト感想を Cc に渡す口。
 * 本文は決めた項目だけ (strict)。 良い点・悪い点はどちらも 1 件以上必須で、 欠けたら 400 (投稿しない)。
 * 宛先は Cc の設定が決める (設定で有効なら Tabula にも載せ、 応答の tabula に結果を返す)。 認証は `x-excubitor-token` を本文より先に確かめる: 受け口専用の鍵 (設定 `playtest_notify.intake_token`) があればそれだけ、
 * 無ければデプロイ・リリース通知と同じ共有トークン (loopback 運用では省略可)。 鍵が合わなければ本文を読まずに 401 (`src/playtest-review/playtest-review-auth.ts`)。
 * run の動画を付けるときは multipart/form-data で、 `review` に同じ本文の JSON、 `video` に mp4 を入れる
 * (上限 PLAYTEST_VIDEO_MAX_BYTES、 超えたら 413)。 応答の video に宛先ごとの添付の成否を返す。
 *
 * @implements spec/feature/playtest-review-notify.md — 受け口
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { announcePlaytestReview, type PlaytestAnnounceDeps } from "../playtest-review/announce-playtest-review.js";
import type { PlaytestReviewAuthDecision } from "../playtest-review/playtest-review-auth.js";
import { PlaytestReviewEventSchema } from "../playtest-review/playtest-review-schema.js";
import { PLAYTEST_VIDEO_MAX_BYTES, type PlaytestReviewVideo } from "../playtest-review/playtest-review-video.js";

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

export function playtestReviewRouter(deps: PlaytestAnnounceDeps & {
  /** 鍵の判定。 本文 (スキーマ検証) より先に呼ぶ。 */
  authorize: (header: string | undefined) => PlaytestReviewAuthDecision;
}): Hono {
  const app = new Hono();
  app.post("/", bodyLimit({ maxSize: REQUEST_MAX_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    const auth = deps.authorize(c.req.header("x-excubitor-token"));
    if (!auth.allowed) {
      // 鍵の値・提示値は残さない。 本文を読む前なので runId 等も出さない (CC-PLAYTEST-INV-07)。
      deps.log?.warn({ reason: auth.reason }, "playtest-review rejected an unauthorized request");
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await readBody(c);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const parsed = PlaytestReviewEventSchema.safeParse(body.event);
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const outcome = await announcePlaytestReview(deps, parsed.data, body.video);
    return c.json(outcome, outcome.duplicate ? 200 : 202);
  });
  return app;
}
