import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, makeTestDir } from "../../tests/helpers/db.js";
import { DomainReviewRepo } from "../db/domain-review-repo.js";
import { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { AnatomiaDomainClient } from "./anatomia-client.js";
import { PLAN_DIR_REL } from "./plan-file.js";
import { DomainReviewService, type DomainReviewPostPort } from "./service.js";

const BUSINESS_VIEW = {
  domains: [{
    id: "session-lifecycle",
    name: "session-lifecycle",
    purpose: "セッションの生死",
    status: "implemented",
    uxCritical: false,
    parentId: null,
    childIds: [],
  }],
  relations: [],
  unlinkedProgramDomains: [],
};

const PROGRAM_VIEW = {
  layers: [{ layer: "application", domains: [{ id: "session-lifecycle", cohesion: 0.7, misfitCount: 0 }] }],
  dependencies: [],
  diagnostics: [],
};

/** Anatomia の応答を丸ごと差し替える stub (isolate:false で vi.mock が効かないため DI)。 */
function stubAnatomia(overrides: Partial<Record<string, unknown>> = {}): AnatomiaDomainClient {
  return {
    resolveProjectId: vi.fn(async () => ({ ok: true, data: "concordia" })),
    listProjects: vi.fn(async () => ({ ok: true, data: [] })),
    fetchBusinessDomainView: vi.fn(async () => ({ ok: true, data: BUSINESS_VIEW })),
    fetchProgramDomainView: vi.fn(async () => ({ ok: true, data: PROGRAM_VIEW })),
    fetchRawDomains: vi.fn(async () => ({
      ok: true,
      data: [{ domain: "governance", implementorCount: 3, conforms: true, violationCount: 0 }],
    })),
    ...overrides,
  } as unknown as AnatomiaDomainClient;
}

function makeService(input: {
  anatomia?: AnatomiaDomainClient;
  post?: DomainReviewPostPort["post"];
  domainReview?: boolean;
  repoPath?: string;
  resolveSession?: (sessionId: string) => { repoPath: string; repoOrigin: string | null } | null;
  replyAllowed?: boolean;
} = {}) {
  const db = makeTestDb();
  const projectCodes = new ProjectCodesRepo(db);
  const posts = new DomainReviewRepo(db);
  const repoPath = input.repoPath ?? "E:/Document/Ars/Concordia";
  projectCodes.register({
    code: "Cc",
    project: "Concordia",
    repoPath,
    repoOrigin: "https://github.com/LUDIARS/Concordia.git",
    addedBy: "test",
  });
  if (input.domainReview === false) projectCodes.update("Cc", { domainReview: false });

  const post = input.post
    ?? vi.fn(async () => ({ platform: "discord", channelId: "chan-1", messageId: "msg-1" }));
  const service = new DomainReviewService({
    projectCodes,
    posts,
    poster: { post },
    log: { info: () => undefined, warn: () => undefined },
    anatomia: input.anatomia ?? stubAnatomia(),
    // 画像は任意。 テストでは撮らない (headless Edge に依存させない)。
    captureImage: async () => null,
    isReplyAuthorAllowed: () => input.replyAllowed !== false,
    ...(input.resolveSession ? { resolveSession: input.resolveSession } : {}),
  });
  return { service, projectCodes, posts, post, repoPath };
}

describe("DomainReviewService.request", () => {
  it("対象プロジェクトなら投稿し、message id を台帳に残す", async () => {
    const { service, posts } = makeService();
    const outcome = await service.request({ trigger: "manual", code: "Cc" });
    expect(outcome.posted).toBe(true);
    if (!outcome.posted) return;
    expect(outcome.report.source).toBe("prepared");
    expect(posts.findPostByMessage("discord", "msg-1")?.code).toBe("Cc");
  });

  it("domain_review が OFF なら投稿しない", async () => {
    const { service, post } = makeService({ domainReview: false });
    const outcome = await service.request({ trigger: "manual", code: "Cc" });
    expect(outcome).toEqual({ posted: false, reason: "domain_review_disabled" });
    expect(post).not.toHaveBeenCalled();
  });

  it("未登録の略称なら投稿しない", async () => {
    const { service } = makeService();
    expect(await service.request({ trigger: "manual", code: "Zz" }))
      .toEqual({ posted: false, reason: "project_not_registered" });
  });

  it("Anatomia が落ちていれば黙って諦める", async () => {
    const { service, post } = makeService({
      anatomia: stubAnatomia({
        fetchBusinessDomainView: vi.fn(async () => ({ ok: false, reason: "unreachable" })),
        fetchProgramDomainView: vi.fn(async () => ({ ok: false, reason: "unreachable" })),
      }),
    });
    expect(await service.request({ trigger: "local-pr", repoOrigin: "LUDIARS/Concordia" }))
      .toEqual({ posted: false, reason: "anatomia_unreachable" });
    expect(post).not.toHaveBeenCalled();
  });

  it("prepared view の片方だけ失敗したら欠落を投稿本文で明示する", async () => {
    const missingBusiness = makeService({
      anatomia: stubAnatomia({
        fetchBusinessDomainView: vi.fn(async () => ({ ok: false, reason: "unreachable" })),
      }),
    });
    const businessOutcome = await missingBusiness.service.request({ trigger: "manual", code: "Cc" });
    expect(businessOutcome.posted).toBe(true);
    if (!businessOutcome.posted) return;
    expect(businessOutcome.report.notes.join("\n")).toContain("business-domain-view");
    expect(businessOutcome.report.notes.join("\n")).toContain("不完全");

    const missingProgram = makeService({
      anatomia: stubAnatomia({
        fetchProgramDomainView: vi.fn(async () => ({ ok: false, reason: "not-prepared" })),
      }),
    });
    const programOutcome = await missingProgram.service.request({ trigger: "manual", code: "Cc" });
    expect(programOutcome.posted).toBe(true);
    if (!programOutcome.posted) return;
    expect(programOutcome.report.notes.join("\n")).toContain("program-domain-view");
    expect(programOutcome.report.notes.join("\n")).toContain("不完全");
  });

  it("プロジェクト一覧の取得失敗も unknown ではなく unreachable として返す", async () => {
    const { service, post } = makeService({
      anatomia: stubAnatomia({
        resolveProjectId: vi.fn(async () => ({ ok: false, reason: "unreachable" })),
      }),
    });
    expect(await service.request({ trigger: "manual", code: "Cc" }))
      .toEqual({ posted: false, reason: "anatomia_unreachable" });
    expect(post).not.toHaveBeenCalled();
  });

  it("Anatomia に登録が無ければ投稿しない", async () => {
    const { service } = makeService({
      anatomia: stubAnatomia({ resolveProjectId: vi.fn(async () => ({ ok: true, data: null })) }),
    });
    expect(await service.request({ trigger: "manual", code: "Cc" }))
      .toEqual({ posted: false, reason: "anatomia_project_unknown" });
  });

  it("sibling worktree でも登録済み本体から Anatomia project を解決する", async () => {
    const resolveProjectId = vi.fn(async (path: string) => ({
      ok: true as const,
      data: path === "E:/Document/Ars/Concordia" ? "concordia" : "ars",
    }));
    const { service } = makeService({ anatomia: stubAnatomia({ resolveProjectId }) });
    const outcome = await service.request({
      trigger: "local-pr",
      repoOrigin: "LUDIARS/Concordia",
      repoPath: "E:/Document/Ars/Concordia-feat-x",
    });
    expect(outcome.posted).toBe(true);
    if (!outcome.posted) return;
    expect(outcome.report.anatomiaProjectId).toBe("concordia");
    expect(resolveProjectId).toHaveBeenCalledTimes(1);
    expect(resolveProjectId).toHaveBeenCalledWith("E:/Document/Ars/Concordia");
  });

  it("HTTP 発火の session checkout は登録 origin が一致するときだけ plan I/O に使う", async () => {
    const registeredPath = makeTestDir("cc-domain-review-registered-");
    const sessionPath = makeTestDir("cc-domain-review-session-");
    await mkdir(join(sessionPath, PLAN_DIR_REL), { recursive: true });
    await writeFile(
      join(sessionPath, PLAN_DIR_REL, "0123456789abcdef.json"),
      JSON.stringify({ questions: ["session plan"], unresolved: [] }),
      "utf8",
    );
    const matching = makeService({
      repoPath: registeredPath,
      resolveSession: () => ({
        repoPath: sessionPath,
        repoOrigin: "https://github.com/LUDIARS/Concordia.git",
      }),
    });
    const outcome = await matching.service.request({ trigger: "plan", code: "Cc", sessionId: "session-1" });
    expect(outcome.posted && outcome.report.planQuestions).toEqual(["session plan"]);

    const mismatched = makeService({
      repoPath: registeredPath,
      resolveSession: () => ({ repoPath: sessionPath, repoOrigin: "other/Project" }),
    });
    const rejected = await mismatched.service.request({ trigger: "plan", code: "Cc", sessionId: "session-2" });
    expect(rejected.posted && rejected.report.planQuestions).toEqual([]);
  });

  it("未 prepare は自動契機では投稿せず、明示要求だけ生データで代替する", async () => {
    const notPrepared = () => stubAnatomia({
      fetchBusinessDomainView: vi.fn(async () => ({ ok: false, reason: "not-prepared" })),
      fetchProgramDomainView: vi.fn(async () => ({ ok: false, reason: "not-prepared" })),
    });

    const auto = makeService({ anatomia: notPrepared() });
    expect(await auto.service.request({ trigger: "local-pr", repoOrigin: "LUDIARS/Concordia" }))
      .toEqual({ posted: false, reason: "not_prepared" });
    expect(auto.post).not.toHaveBeenCalled();

    const manual = makeService({ anatomia: notPrepared() });
    const outcome = await manual.service.request({ trigger: "manual", code: "Cc" });
    expect(outcome.posted).toBe(true);
    if (!outcome.posted) return;
    expect(outcome.report.source).toBe("raw");
    expect(outcome.report.notes.join("")).toContain("prepare");
  });

  it("投稿に失敗したら台帳へ残さない", async () => {
    const { service, posts } = makeService({ post: vi.fn(async () => null) });
    expect(await service.request({ trigger: "manual", code: "Cc" }))
      .toEqual({ posted: false, reason: "post_failed" });
    expect(posts.findPostByMessage("discord", "msg-1")).toBeNull();
  });

  it("plan 契機だけ plan の問いを載せる", async () => {
    const repoPath = makeTestDir("cc-domain-review-plan-");
    await mkdir(join(repoPath, PLAN_DIR_REL), { recursive: true });
    await writeFile(
      join(repoPath, PLAN_DIR_REL, "0123456789abcdef.json"),
      JSON.stringify({ questions: ["新規ドメインの説明は妥当か"], unresolved: [] }),
      "utf8",
    );

    const withPlan = makeService({ repoPath });
    const planned = await withPlan.service.request({ trigger: "plan", code: "Cc" });
    expect(planned.posted).toBe(true);
    if (!planned.posted) return;
    expect(planned.report.planQuestions).toEqual(["新規ドメインの説明は妥当か"]);
    expect(withPlan.posts.findPostByMessage("discord", "msg-1")?.plan_task_hash)
      .toBe("0123456789abcdef");

    const manual = makeService({ repoPath });
    const unplanned = await manual.service.request({ trigger: "manual", code: "Cc" });
    expect(unplanned.posted).toBe(true);
    if (!unplanned.posted) return;
    expect(unplanned.report.planQuestions).toEqual([]);
  });
});

describe("DomainReviewService.recordReply", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = makeTestDir("cc-domain-review-reply-");
    await mkdir(join(repoPath, PLAN_DIR_REL), { recursive: true });
    await writeFile(
      join(repoPath, PLAN_DIR_REL, "0123456789abcdef.json"),
      JSON.stringify({ questions: ["問い"], unresolved: [] }),
      "utf8",
    );
  });

  it("知らない message への返信は取り込まない", async () => {
    const { service } = makeService();
    expect(await service.recordReply({
      platform: "discord",
      messageId: "unknown",
      authorId: "42",
      text: "何か",
      source: "discord:c/m",
    })).toEqual({ handled: false });
  });

  it("管理職権限の無い回答者は台帳にも plan にも書き込まない", async () => {
    const { service, posts } = makeService({ repoPath, replyAllowed: false });
    await service.request({ trigger: "plan", code: "Cc" });

    expect(await service.recordReply({
      platform: "discord",
      messageId: "msg-1",
      authorId: "staff-user",
      text: "書き換えたい",
      source: "discord:c/denied",
    })).toEqual({ handled: true, authorized: false, code: "Cc" });

    const post = posts.findPostByMessage("discord", "msg-1")!;
    expect(posts.listAnswers(post.id)).toEqual([]);
    const plan = JSON.parse(
      await readFile(join(repoPath, PLAN_DIR_REL, "0123456789abcdef.json"), "utf8"),
    ) as { reviewAnswers?: unknown[] };
    expect(plan.reviewAnswers).toBeUndefined();
  });

  it("plan 起点の投稿への返信は plan の突合資料へ追記される", async () => {
    const { service, posts } = makeService({ repoPath });
    await service.request({ trigger: "plan", code: "Cc" });

    const result = await service.recordReply({
      platform: "discord",
      messageId: "msg-1",
      authorId: "42",
      text: "説明はこう直したい",
      source: "discord:c/m",
    });
    expect(result).toMatchObject({ handled: true, kind: "plan-question", planAppended: true });

    const post = posts.findPostByMessage("discord", "msg-1")!;
    const answers = posts.listAnswers(post.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.answer_text).toBe("説明はこう直したい");
  });

  it("plan を伴わない投稿への返信は台帳にだけ残る", async () => {
    const { service, posts } = makeService({ repoPath });
    await service.request({ trigger: "manual", code: "Cc" });

    const result = await service.recordReply({
      platform: "discord",
      messageId: "msg-1",
      authorId: "42",
      text: "境界がおかしい",
      source: "discord:c/m",
    });
    expect(result).toMatchObject({ handled: true, kind: "domain-note", planAppended: false });
    const post = posts.findPostByMessage("discord", "msg-1")!;
    expect(posts.listAnswers(post.id)).toHaveLength(1);
  });

  it("空白だけの返信は回答として扱わない", async () => {
    const { service } = makeService({ repoPath });
    await service.request({ trigger: "manual", code: "Cc" });
    expect(await service.recordReply({
      platform: "discord",
      messageId: "msg-1",
      authorId: "42",
      text: "   ",
      source: "discord:c/m",
    })).toEqual({ handled: false });
  });

  it("同じ Discord 返信の再配送は plan と台帳へ一度だけ記録する", async () => {
    const { service, posts } = makeService({ repoPath });
    await service.request({ trigger: "plan", code: "Cc" });
    const reply = {
      platform: "discord",
      messageId: "msg-1",
      authorId: "42",
      text: "同じ回答",
      source: "discord:c/reply-1",
    };

    await Promise.all([service.recordReply(reply), service.recordReply(reply)]);

    const post = posts.findPostByMessage("discord", "msg-1")!;
    expect(posts.listAnswers(post.id)).toHaveLength(1);
    const plan = JSON.parse(
      await readFile(join(repoPath, PLAN_DIR_REL, "0123456789abcdef.json"), "utf8"),
    ) as { reviewAnswers: unknown[] };
    expect(plan.reviewAnswers).toHaveLength(1);
  });

  it("同時に届いた別々の回答を plan と台帳の両方に残す", async () => {
    const { service, posts } = makeService({ repoPath });
    await service.request({ trigger: "plan", code: "Cc" });

    await Promise.all([1, 2].map((id) => service.recordReply({
      platform: "discord",
      messageId: "msg-1",
      authorId: String(id),
      text: `回答 ${id}`,
      source: `discord:c/reply-${id}`,
    })));

    const post = posts.findPostByMessage("discord", "msg-1")!;
    expect(posts.listAnswers(post.id)).toHaveLength(2);
    const plan = JSON.parse(
      await readFile(join(repoPath, PLAN_DIR_REL, "0123456789abcdef.json"), "utf8"),
    ) as { reviewAnswers: unknown[] };
    expect(plan.reviewAnswers).toHaveLength(2);
  });
});
