import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DomainReviewRepo } from "../db/domain-review-repo.js";
import type { DomainReviewService } from "../domain-review/service.js";
import { domainReviewRouter } from "./domain-review.js";

function router(service: Partial<DomainReviewService>, posts = new DomainReviewRepo(makeTestDb())) {
  return {
    app: domainReviewRouter({ service: service as DomainReviewService, posts }),
    posts,
  };
}

async function post(app: ReturnType<typeof domainReviewRouter>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/domain-review", () => {
  it("code も repo_origin も無い要求は 400", async () => {
    const { app } = router({ request: vi.fn() });
    const res = await post(app, "/", { trigger: "manual" });
    expect(res.status).toBe(400);
  });

  it("投稿できたら件数を返す", async () => {
    const request = vi.fn(async () => ({
      posted: true as const,
      postId: 7,
      imageAttached: true,
      report: {
        source: "prepared" as const,
        coreDomains: [{}, {}],
        layers: [{}],
        layerViolations: [],
        planQuestions: [{}],
      },
    }));
    const { app } = router({ request } as unknown as Partial<DomainReviewService>);
    const res = await post(app, "/", { trigger: "manual", code: "Cc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      posted: true,
      post_id: 7,
      source: "prepared",
      core_domains: 2,
      layers: 1,
      layer_violations: 0,
      plan_questions: 1,
      image_attached: true,
    });
  });

  it("見送りは 200 + 理由 (呼び出し側のエラーにしない)", async () => {
    const request = vi.fn(async () => ({ posted: false as const, reason: "domain_review_disabled" as const }));
    const { app } = router({ request } as unknown as Partial<DomainReviewService>);
    const res = await post(app, "/", { trigger: "local-pr", repo_origin: "LUDIARS/Concordia" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posted: false, reason: "domain_review_disabled" });
  });

  it("plan hash は 16 桁 hex しか受けない", async () => {
    const { app } = router({ request: vi.fn() });
    const res = await post(app, "/", { trigger: "plan", code: "Cc", plan_task_hash: "../../etc" });
    expect(res.status).toBe(400);
  });

  it("HTTP 呼び出し元に任意の checkout path を選ばせない", async () => {
    const request = vi.fn();
    const { app } = router({ request });
    const res = await post(app, "/", {
      trigger: "plan",
      code: "Cc",
      repo_path: "E:/Document/Ars/OtherProject",
    });
    expect(res.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("POST /v1/domain-review/replies", () => {
  it("取り込めた返信は種別と追記結果を返す", async () => {
    const recordReply = vi.fn(async () => ({
      handled: true as const,
      authorized: true as const,
      kind: "plan-question" as const,
      planAppended: true,
      code: "Cc",
    }));
    const { app } = router({ recordReply } as unknown as Partial<DomainReviewService>);
    const res = await post(app, "/replies", {
      message_id: "msg-1",
      author_id: "42",
      text: "回答",
      source: "discord:c/m",
    });
    expect(await res.json()).toEqual({
      handled: true,
      authorized: true,
      kind: "plan-question",
      plan_appended: true,
      code: "Cc",
    });
  });

  it("権限不足は対象返信として処理済みにしつつ書込み拒否を返す", async () => {
    const recordReply = vi.fn(async () => ({
      handled: true as const,
      authorized: false as const,
      code: "Cc",
    }));
    const { app } = router({ recordReply } as unknown as Partial<DomainReviewService>);
    const res = await post(app, "/replies", {
      message_id: "msg-1",
      author_id: "staff-user",
      text: "回答",
      source: "discord:c/m",
    });
    expect(await res.json()).toEqual({ handled: true, authorized: false, code: "Cc" });
  });

  it("対象外の message は handled: false", async () => {
    const recordReply = vi.fn(async () => ({ handled: false as const }));
    const { app } = router({ recordReply } as unknown as Partial<DomainReviewService>);
    const res = await post(app, "/replies", {
      message_id: "msg-x",
      author_id: "42",
      text: "回答",
      source: "discord:c/m",
    });
    expect(await res.json()).toEqual({ handled: false });
  });
});

describe("GET /v1/domain-review/posts/:id", () => {
  it("投稿と回答を 1 本で読める", async () => {
    const posts = new DomainReviewRepo(makeTestDb());
    const stored = posts.recordPost({
      code: "Cc",
      repoPath: "E:/Document/Ars/Concordia",
      anatomiaProjectId: "concordia",
      planTaskHash: "0123456789abcdef",
      triggerKind: "plan",
      platform: "discord",
      channelId: "chan-1",
      messageId: "msg-1",
      questions: ["問い"],
    });
    posts.recordAnswer({
      postId: stored.id,
      kind: "plan-question",
      answeredBy: "discord:42",
      answerText: "回答",
      source: "discord:c/m",
      planAppended: true,
    });
    const { app } = router({}, posts);
    const res = await app.request(`/posts/${stored.id}`);
    const body = await res.json() as { post: { questions: string[] }; answers: unknown[] };
    expect(body.post.questions).toEqual(["問い"]);
    expect(body.answers).toHaveLength(1);
  });

  it("知らない id は 404", async () => {
    const { app } = router({});
    expect((await app.request("/posts/999")).status).toBe(404);
  });
});
