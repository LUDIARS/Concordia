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

describe("GET /v1/domain-review/posts", () => {
  const LIST_FIELDS = [
    "code", "core_domains", "id", "layer_violations", "layers",
    "plan_questions", "posted_at", "repo_origin", "source", "trigger",
  ];

  /** created_at を 1 分刻みで固定して積む。 i が大きいほど新しい。 */
  function seed(count: number, code: (index: number) => string = () => "Cc") {
    const db = makeTestDb();
    const posts = new DomainReviewRepo(db);
    for (let index = 0; index < count; index += 1) {
      const stored = posts.recordPost({
        code: code(index),
        repoPath: "E:/Document/Ars/Concordia",
        anatomiaProjectId: "concordia",
        planTaskHash: "0123456789abcdef",
        triggerKind: "plan",
        platform: "discord",
        channelId: "chan-body",
        messageId: `msg-body-${index}`,
        questions: ["問いの本文"],
        summary: { source: "prepared", coreDomains: 4, layers: 2, layerViolations: 1 },
      });
      db.prepare("UPDATE domain_review_posts SET created_at = ? WHERE id = ?")
        .run(Date.UTC(2026, 8, 26, 0, index), stored.id);
    }
    return posts;
  }

  async function list(posts: DomainReviewRepo, query = "") {
    const { app } = router({}, posts);
    return app.request(`/posts${query}`);
  }

  it("200 で posted_at の新しい順に要約を返す", async () => {
    const res = await list(seed(3));
    expect(res.status).toBe(200);
    const body = await res.json() as { posts: Array<Record<string, unknown>> };
    expect(body.posts.map((post) => post.posted_at)).toEqual([
      "2026-09-26T00:02:00.000Z",
      "2026-09-26T00:01:00.000Z",
      "2026-09-26T00:00:00.000Z",
    ]);
    expect(body.posts[0]).toMatchObject({
      code: "Cc",
      repo_origin: null,
      trigger: "plan",
      source: "prepared",
      core_domains: 4,
      layers: 2,
      layer_violations: 1,
      plan_questions: 1,
    });
  });

  it("レポート本文・問いの本文・Discord の宛先を 1 項目も返さない", async () => {
    const res = await list(seed(2));
    const text = await res.text();
    const body = JSON.parse(text) as { posts: Array<Record<string, unknown>> };
    for (const post of body.posts) expect(Object.keys(post).sort()).toEqual(LIST_FIELDS);
    expect(text).not.toContain("問いの本文");
    expect(text).not.toContain("msg-body");
    expect(text).not.toContain("chan-body");
  });

  it("limit は既定 20 件、上限 100 件に丸める", async () => {
    const posts = seed(101);
    const byDefault = await (await list(posts)).json() as { posts: unknown[] };
    expect(byDefault.posts).toHaveLength(20);
    const capped = await (await list(posts, "?limit=500")).json() as { posts: unknown[] };
    expect(capped.posts).toHaveLength(100);
    const small = await (await list(posts, "?limit=3")).json() as { posts: unknown[] };
    expect(small.posts).toHaveLength(3);
  });

  it("code で絞り込み、未指定は全プロジェクト、存在しない code は空配列", async () => {
    const posts = seed(4, (index) => (index % 2 === 0 ? "Cc" : "Br"));
    const cc = await (await list(posts, "?code=Cc")).json() as { posts: Array<{ code: string }> };
    expect(cc.posts.map((post) => post.code)).toEqual(["Cc", "Cc"]);
    const all = await (await list(posts)).json() as { posts: unknown[] };
    expect(all.posts).toHaveLength(4);
    const unknown = await list(posts, "?code=Zz");
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ posts: [] });
  });

  it("長すぎる code は 400", async () => {
    const res = await list(seed(1), `?code=${"x".repeat(65)}`);
    expect(res.status).toBe(400);
  });

  it("一覧を読んでも台帳を書き換えない (読み取り専用)", async () => {
    const posts = seed(2);
    const before = posts.listByCode(null, 10);
    await list(posts);
    expect(posts.listByCode(null, 10)).toEqual(before);
  });
});
