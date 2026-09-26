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

  it("投稿したレポートの件数を残し、件数の無い再記録で null に戻さない", () => {
    const repo = new DomainReviewRepo(makeTestDb());
    const first = repo.recordPost(postInput({
      summary: { source: "prepared", coreDomains: 5, layers: 3, layerViolations: 1 },
    }));
    expect(first).toMatchObject({
      report_source: "prepared",
      core_domain_count: 5,
      layer_count: 3,
      layer_violation_count: 1,
    });
    const again = repo.recordPost(postInput({ questions: ["再記録"] }));
    expect(again).toMatchObject({ report_source: "prepared", core_domain_count: 5, layer_count: 3, layer_violation_count: 1 });
  });

  it("件数を渡さない投稿は 0 で埋めず null のまま残す", () => {
    const repo = new DomainReviewRepo(makeTestDb());
    expect(repo.recordPost(postInput())).toMatchObject({
      report_source: null,
      core_domain_count: null,
      layer_count: null,
      layer_violation_count: null,
    });
  });
});

describe("DomainReviewRepo.listByCode", () => {
  /** created_at を固定して積む (Date.now に順序を委ねない)。 */
  function seed(db: ReturnType<typeof makeTestDb>, rows: Array<{ code: string; messageId: string; at: number }>) {
    const repo = new DomainReviewRepo(db);
    for (const row of rows) {
      const post = repo.recordPost(postInput({ code: row.code, messageId: row.messageId }));
      db.prepare("UPDATE domain_review_posts SET created_at = ? WHERE id = ?").run(row.at, post.id);
    }
    return repo;
  }

  it("posted_at の新しい順に返し、同時刻は id の大きい方を先にする", () => {
    const repo = seed(makeTestDb(), [
      { code: "Cc", messageId: "old", at: 1_000 },
      { code: "Cc", messageId: "new", at: 3_000 },
      { code: "Cc", messageId: "tie-a", at: 2_000 },
      { code: "Cc", messageId: "tie-b", at: 2_000 },
    ]);
    expect(repo.listByCode("Cc", 10).map((row) => row.message_id)).toEqual(["new", "tie-b", "tie-a", "old"]);
  });

  it("limit 件までしか返さない", () => {
    const repo = seed(makeTestDb(), [
      { code: "Cc", messageId: "m1", at: 1_000 },
      { code: "Cc", messageId: "m2", at: 2_000 },
      { code: "Cc", messageId: "m3", at: 3_000 },
    ]);
    expect(repo.listByCode("Cc", 2).map((row) => row.message_id)).toEqual(["m3", "m2"]);
  });

  it("code 指定はその code だけ (大文字小文字を区別)、null は全プロジェクト、未知の code は空", () => {
    const repo = seed(makeTestDb(), [
      { code: "Cc", messageId: "cc-1", at: 1_000 },
      { code: "Br", messageId: "br-1", at: 2_000 },
      { code: "Cc", messageId: "cc-2", at: 3_000 },
    ]);
    expect(repo.listByCode("Cc", 10).map((row) => row.message_id)).toEqual(["cc-2", "cc-1"]);
    expect(repo.listByCode("cc", 10)).toEqual([]);
    expect(repo.listByCode(null, 10).map((row) => row.message_id)).toEqual(["cc-2", "br-1", "cc-1"]);
    expect(repo.listByCode("Zz", 10)).toEqual([]);
  });

  it("repo_origin は project_codes の登録から引き、未登録の code は null", () => {
    const db = makeTestDb();
    new ProjectCodesRepo(db).register({
      code: "Cc",
      project: "Concordia",
      repoPath: "E:/Document/Ars/Concordia",
      repoOrigin: "https://github.com/LUDIARS/Concordia.git",
      addedBy: "test",
    });
    const repo = seed(db, [
      { code: "Cc", messageId: "cc-1", at: 2_000 },
      { code: "Br", messageId: "br-1", at: 1_000 },
    ]);
    expect(repo.listByCode(null, 10).map((row) => [row.code, row.repo_origin])).toEqual([
      ["Cc", "https://github.com/LUDIARS/Concordia.git"],
      ["Br", null],
    ]);
  });

  it("正の整数でない limit は SQL へ渡さず拒否する (負の LIMIT は無制限になるため)", () => {
    const repo = seed(makeTestDb(), [{ code: "Cc", messageId: "m1", at: 1_000 }]);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => repo.listByCode("Cc", limit)).toThrow(RangeError);
    }
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
