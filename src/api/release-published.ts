import { Hono } from "hono";
import { z } from "zod";
import {
  handleReleasePublished,
  type ReleaseNoticeDelivery,
  type ReleaseNoticeLedger,
  type ReleaseNoticeLookup,
} from "../deploy/release-published.js";

const EventSchema = z.object({
  repository: z.string().trim().min(1).max(512),
  kind: z.enum(["major", "minor"]),
  tag: z.string().trim().min(1).max(128),
  previousTag: z.string().trim().min(1).max(128).nullable(),
  version: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(512),
  notice: z.string().max(20_000),
  releaseUrl: z.string().url().max(2_048),
  publishedAt: z.string().datetime(),
}).strict();

export function releasePublishedRouter(deps: {
  ledger: ReleaseNoticeLedger;
  lookup: ReleaseNoticeLookup;
  delivery: ReleaseNoticeDelivery;
  authorize: (header: string | undefined) => boolean;
  log?: { info: (detail: Record<string, unknown>, message: string) => void; warn: (detail: Record<string, unknown>, message: string) => void };
}): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    if (!deps.authorize(c.req.header("x-excubitor-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = EventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const outcome = await handleReleasePublished({ event: parsed.data, ledger: deps.ledger, lookup: deps.lookup, delivery: deps.delivery });
    const detail = {
      repository: parsed.data.repository,
      tag: parsed.data.tag,
      duplicate: outcome.duplicate,
      unconfigured: outcome.unconfigured,
      delivered: outcome.delivered.map((result) => result.target),
      failed: outcome.failed.map((result) => ({ ...result.target, error: result.error })),
    };
    // 一部の宛先だけ落ちる構成になったので、 失敗の有無は件数で見る。 1 件でも落ちていれば
    // 残りが届いていても warn に出す — 子会社だけ届いていない状態を info に埋めない。
    if (outcome.failed.length > 0) deps.log?.warn(detail, "release-published delivery failed");
    else if (outcome.unconfigured) deps.log?.info(detail, "release-published delivery skipped because no destination is configured");
    else deps.log?.info(detail, "release-published delivery completed");
    return c.json(outcome, outcome.duplicate ? 200 : 202);
  });
  return app;
}
