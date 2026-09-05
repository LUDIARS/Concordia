/**
 * /v1/domain-review — ドメインレビュー投稿の発火口と、返信の取り込み口。
 *
 * 発火の 3 契機 (設計書 §8.2 C-4) のうち、 local PR 提出は Cc 内部から直接
 * サービスを呼ぶ。 ここが要るのは残り 2 つ:
 *  - `anatomia plan` を作った側 (Castra の supply hook) からの通知
 *  - Discord の `/domain-review <code>`
 *
 * 見送りは 200 + `posted: false` + 理由で返す。 404/409 にしないのは、
 * 「発火はしたが投稿対象ではなかった」を呼び出し側がエラーとして扱わないため。
 *
 * @implements spec/feature/domain-review-discord.md §2.1, §2.4, §4
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DomainReviewRepo } from "../db/domain-review-repo.js";
import { parsePostQuestions } from "../db/domain-review-repo.js";
import type { DomainReviewService } from "../domain-review/service.js";

const RequestSchema = z.object({
  trigger: z.enum(["plan", "local-pr", "manual"]).default("manual"),
  code: z.string().trim().min(1).max(64).optional(),
  repo_origin: z.string().trim().min(1).max(1_000).optional(),
  channel_id: z.string().trim().min(1).max(64).optional(),
  session_id: z.string().trim().min(1).max(200).optional(),
  plan_task_hash: z.string().trim().regex(/^[a-f0-9]{16}$/).optional(),
}).strict().refine(
  (body) => Boolean(body.code || body.repo_origin),
  { message: "code or repo_origin is required" },
);

const ReplySchema = z.object({
  platform: z.enum(["discord", "slack"]).default("discord"),
  message_id: z.string().trim().min(1).max(64),
  author_id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(4_000),
  source: z.string().trim().min(1).max(200),
}).strict();

export interface DomainReviewApiDeps {
  service: DomainReviewService;
  posts: DomainReviewRepo;
}

export function domainReviewRouter(deps: DomainReviewApiDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = RequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_domain_review_request", detail: parsed.error.flatten() }, 400);
    const outcome = await deps.service.request({
      trigger: parsed.data.trigger,
      code: parsed.data.code ?? null,
      repoOrigin: parsed.data.repo_origin ?? null,
      channelId: parsed.data.channel_id ?? null,
      sessionId: parsed.data.session_id ?? null,
      planTaskHash: parsed.data.plan_task_hash ?? null,
    });
    return outcome.posted
      ? c.json({
        posted: true,
        post_id: outcome.postId,
        source: outcome.report.source,
        core_domains: outcome.report.coreDomains.length,
        layers: outcome.report.layers.length,
        layer_violations: outcome.report.layerViolations.length,
        plan_questions: outcome.report.planQuestions.length,
        image_attached: outcome.imageAttached,
      })
      : c.json({ posted: false, reason: outcome.reason });
  });

  app.post("/replies", async (c) => {
    const parsed = ReplySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_domain_review_reply", detail: parsed.error.flatten() }, 400);
    const result = await deps.service.recordReply({
      platform: parsed.data.platform,
      messageId: parsed.data.message_id,
      authorId: parsed.data.author_id,
      text: parsed.data.text,
      source: parsed.data.source,
    });
    if (!result.handled) return c.json({ handled: false });
    if (!result.authorized) return c.json({ handled: true, authorized: false, code: result.code });
    return c.json({
      handled: true,
      authorized: true,
      kind: result.kind,
      plan_appended: result.planAppended,
      code: result.code,
    });
  });

  /** 監査用。 どの投稿にどんな回答が付いたかを 1 本で読む。 */
  app.get("/posts/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_post_id" }, 400);
    const post = deps.posts.findPostById(id);
    if (!post) return c.json({ error: "domain_review_post_not_found" }, 404);
    return c.json({
      post: {
        id: post.id,
        code: post.code,
        repo_path: post.repo_path,
        anatomia_project_id: post.anatomia_project_id,
        plan_task_hash: post.plan_task_hash,
        trigger: post.trigger_kind,
        platform: post.platform,
        channel_id: post.channel_id,
        message_id: post.message_id,
        questions: parsePostQuestions(post),
        created_at: post.created_at,
      },
      answers: deps.posts.listAnswers(post.id).map((row) => ({
        id: row.id,
        kind: row.kind,
        answered_by: row.answered_by,
        text: row.answer_text,
        source: row.source,
        plan_appended: row.plan_appended === 1,
        created_at: row.created_at,
      })),
    });
  });

  return app;
}
