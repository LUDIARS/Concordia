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
 * `GET /posts` は投稿一覧の読み取り口 (Breviarium が最新レビューの日時を読む)。
 * 書き込みは一切せず、 レポート本文・画像・Discord message 本文は返さない。
 *
 * `POST /answers/:id/note-domain` と `POST /answers/:id/note-delivery/retry` は
 * ドメインへの指摘を Anatomia の review-notes へ渡す選択・再試行の口 (§4.2)。
 *
 * @implements spec/feature/domain-review-discord.md §2.1, §2.4, §4, §4.2, §8
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { DomainReviewRepo } from "../db/domain-review-repo.js";
import { parsePostQuestions } from "../db/domain-review-repo.js";
import type { NoteChoiceResult, NoteDeliveryOutcome } from "../domain-review/note-delivery.js";
import { listDomainReviewPosts, type DomainReviewPostSummary } from "../domain-review/post-listing.js";
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

const NoteChoiceSchema = z.object({
  platform: z.enum(["discord", "slack"]).default("discord"),
  actor_id: z.string().trim().min(1).max(64),
  choice: z.string().trim().min(1).max(100),
}).strict();

const NOTE_CHOICE_ERROR_STATUS = {
  answer_not_found: 404,
  not_a_domain_note: 409,
  forbidden: 403,
  invalid_choice: 400,
} as const;

function noteDeliveryResponse(outcome: NoteDeliveryOutcome) {
  switch (outcome.status) {
    case "sent":
      return { status: outcome.status, answer_id: outcome.answerId, domain_id: outcome.domainId, proposal_id: outcome.proposalId };
    case "rejected":
      return { status: outcome.status, answer_id: outcome.answerId, domain_id: outcome.domainId, reason: outcome.reason };
    case "failed":
      return { status: outcome.status, answer_id: outcome.answerId, reason: outcome.reason };
    case "awaiting_choice":
      return {
        status: outcome.status,
        answer_id: outcome.answerId,
        choices: outcome.choices.map((choice) => ({ value: choice.value, label: choice.label })),
        omitted: outcome.omitted,
      };
    case "sending":
      return { status: outcome.status, answer_id: outcome.answerId };
  }
}

function noteChoiceResponse(c: Context, result: NoteChoiceResult) {
  if (!result.ok) return c.json({ error: result.reason }, NOTE_CHOICE_ERROR_STATUS[result.reason]);
  return c.json({ note_delivery: noteDeliveryResponse(result.outcome) });
}

const PostListQuerySchema = z.object({
  code: z.string().trim().max(64).optional(),
  // 丸めは resolvePostListLimit (一覧系共通の clampListLimit と同じ規則) に任せる。
  limit: z.string().optional(),
});

function postSummaryResponse(post: DomainReviewPostSummary) {
  return {
    id: post.id,
    code: post.code,
    repo_origin: post.repoOrigin,
    trigger: post.trigger,
    source: post.source,
    posted_at: post.postedAt,
    core_domains: post.coreDomains,
    layers: post.layers,
    layer_violations: post.layerViolations,
    plan_questions: post.planQuestions,
  };
}

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
      ...(result.noteDelivery ? { note_delivery: noteDeliveryResponse(result.noteDelivery) } : {}),
    });
  });

  /** 選択ダイアログの回答 (§4.2)。 返信者本人か回答権限のある人だけ。 */
  app.post("/answers/:id/note-domain", async (c) => {
    const answerId = Number(c.req.param("id"));
    if (!Number.isInteger(answerId) || answerId <= 0) return c.json({ error: "invalid_answer_id" }, 400);
    const parsed = NoteChoiceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_note_domain_choice", detail: parsed.error.flatten() }, 400);
    const result = await deps.service.chooseNoteDomain({
      answerId,
      choice: parsed.data.choice,
      platform: parsed.data.platform,
      actorId: parsed.data.actor_id,
    });
    return noteChoiceResponse(c, result);
  });

  /** 未送信の指摘の再試行 (§4.2)。 終端済みなら記録を返すだけで再送しない。 */
  app.post("/answers/:id/note-delivery/retry", async (c) => {
    const answerId = Number(c.req.param("id"));
    if (!Number.isInteger(answerId) || answerId <= 0) return c.json({ error: "invalid_answer_id" }, 400);
    return noteChoiceResponse(c, await deps.service.retryNoteDelivery(answerId));
  });

  /** 投稿一覧 (§8)。 code 未指定は全プロジェクト、 存在しない code は空配列。 */
  app.get("/posts", (c) => {
    const parsed = PostListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_domain_review_posts_query", detail: parsed.error.flatten() }, 400);
    }
    const posts = listDomainReviewPosts(deps.posts, {
      code: parsed.data.code || null,
      limit: parsed.data.limit,
    });
    return c.json({ posts: posts.map((post) => postSummaryResponse(post)) });
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
      answers: deps.posts.listAnswers(post.id).map((row) => {
        const delivery = row.kind === "domain-note" ? deps.posts.findNoteDelivery(row.id) : null;
        return {
          id: row.id,
          kind: row.kind,
          answered_by: row.answered_by,
          text: row.answer_text,
          source: row.source,
          plan_appended: row.plan_appended === 1,
          created_at: row.created_at,
          ...(delivery
            ? {
              note_delivery: {
                status: delivery.status,
                domain_id: delivery.project_wide === 1 ? null : delivery.domain_id,
                project_wide: delivery.project_wide === 1,
                proposal_id: delivery.proposal_id,
                reason: delivery.reason,
                attempts: delivery.attempts,
                updated_at: delivery.updated_at,
              },
            }
            : {}),
        };
      }),
    });
  });

  return app;
}
