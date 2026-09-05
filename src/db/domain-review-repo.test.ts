import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DomainReviewRepo, parsePostQuestions } from "./domain-review-repo.js";
import { ProjectCodesRepo } from "./project-codes-repo.js";

function postInput(overrides: Partial<Parameters<DomainReviewRepo["recordPost"]>[0]> = {}) {
  return {
    code: "Cc",
    repoPath: "E:/Document/Ars/Concordia",
    anatomiaProjectId: "concordia",
    planTaskHash: "0123456789abcdef",
    triggerKind: "plan",
    platform: "discord",
    channelId: "chan-1",
    messageId: "msg-1",
    questions: ["問い 1", "問い 2"],
    ...overrides,
  };
}

describe("DomainReviewRepo", () => {
  it("投稿を記録し、message id で引ける", () => {
    const repo = new DomainReviewRepo(makeTestDb());
    const row = repo.recordPost(postInput());
    expect(row.id).toBeGreaterThan(0);
    const found = repo.findPostByMessage("discord", "msg-1");
    expect(found?.code).toBe("Cc");
    expect(parsePostQuestions(found!)).toEqual(["問い 1", "問い 2"]);
  });

  it("同じ message を二度記録しても 1 行に収まる", () => {
    const repo = new DomainReviewRepo(makeTestDb());
    const first = repo.recordPost(postInput());
    const second = repo.recordPost(postInput({ questions: ["更新後"] }));
    expect(second.id).toBe(first.id);
    expect(parsePostQuestions(second)).toEqual(["更新後"]);
  });

  it("回答を投稿に紐付けて時系列で読める", () => {
    const repo = new DomainReviewRepo(makeTestDb());
    const post = repo.recordPost(postInput());
    repo.recordAnswer({
      postId: post.id,
      kind: "plan-question",
      answeredBy: "discord:42",
      answerText: "1 件目",
      source: "discord:c/m1",
      planAppended: true,
    });
    repo.recordAnswer({
      postId: post.id,
      kind: "domain-note",
      answeredBy: "discord:43",
      answerText: "2 件目",
      source: "discord:c/m2",
      planAppended: false,
    });
    const answers = repo.listAnswers(post.id);
    expect(answers.map((a) => a.answer_text)).toEqual(["1 件目", "2 件目"]);
    expect(answers[0]!.plan_appended).toBe(1);
    expect(answers[1]!.plan_appended).toBe(0);
  });

  it("同じ source の回答は process 間の書込みを想定して台帳側でも冪等", () => {
    const repo = new DomainReviewRepo(makeTestDb());
    const post = repo.recordPost(postInput());
    const first = repo.recordAnswer({
      postId: post.id,
      kind: "plan-question",
      answeredBy: "discord:42",
      answerText: "最初の回答",
      source: "discord:c/same-message",
      planAppended: false,
    });
    const duplicate = repo.recordAnswer({
      postId: post.id,
      kind: "plan-question",
      answeredBy: "discord:42",
      answerText: "再配送された回答",
      source: "discord:c/same-message",
      planAppended: false,
    });

    expect(duplicate.id).toBe(first.id);
    expect(repo.listAnswers(post.id).map((row) => row.answer_text)).toEqual(["最初の回答"]);
  });

  it("壊れた questions JSON でも投稿は読める", () => {
    const db = makeTestDb();
    const repo = new DomainReviewRepo(db);
    const post = repo.recordPost(postInput());
    db.prepare("UPDATE domain_review_posts SET questions = ? WHERE id = ?").run("{壊れた", post.id);
    expect(parsePostQuestions(repo.findPostById(post.id)!)).toEqual([]);
  });
});

describe("project_codes.domain_review", () => {
  it("LUDIARS プロダクトの新規登録は既定 ON、外部リポは OFF", () => {
    const repo = new ProjectCodesRepo(makeTestDb());
    const cc = repo.register({
      code: "Cc",
      project: "Concordia",
      repoPath: "E:/Document/Ars/Concordia",
      repoOrigin: "https://github.com/LUDIARS/Concordia.git",
      addedBy: "test",
    });
    expect(cc.row.domain_review).toBe(1);

    const ext = repo.register({
      code: "Zz",
      project: "SomeExternal",
      repoPath: "E:/Document/Ars/SomeExternal",
      repoOrigin: "https://github.com/other-org/SomeExternal.git",
      addedBy: "test",
    });
    expect(ext.row.domain_review).toBe(0);
  });

  it("トグルは update で切り替わり、他の列を巻き添えにしない", () => {
    const repo = new ProjectCodesRepo(makeTestDb());
    repo.register({
      code: "Cc",
      project: "Concordia",
      repoPath: "E:/Document/Ars/Concordia",
      repoOrigin: "https://github.com/LUDIARS/Concordia.git",
      addedBy: "test",
    });
    const off = repo.update("Cc", { domainReview: false });
    expect(off?.domain_review).toBe(0);
    expect(off?.repo_origin).toBe("https://github.com/LUDIARS/Concordia.git");

    // domain_review を渡さない更新は現在値を保つ (勝手に戻さない)。
    const renamed = repo.update("Cc", { project: "ConcordiaRenamed" });
    expect(renamed?.domain_review).toBe(0);
  });
});
