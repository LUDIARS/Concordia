import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DomainReviewRepo } from "../db/domain-review-repo.js";
import type { AnatomiaDomainClient } from "./anatomia-client.js";
import { DomainReviewNoteDelivery, NOTE_DELIVERY_STALE_MS, noteReviewRef } from "./note-delivery.js";
import { NOTE_DOMAIN_PROJECT_WIDE } from "./note-domain.js";

function stubAnatomia(overrides: Partial<Record<string, unknown>> = {}) {
  const submitReviewNotes = vi.fn(async () => ({
    ok: true,
    data: { proposals: [{ proposalId: "p-1", affectedDomainIds: ["combat"] }], rejected: [] },
  }));
  const fetchRawDomains = vi.fn(async () => ({
    ok: true,
    data: [
      { domain: "combat", implementorCount: 1, conforms: true, violationCount: 0 },
      { domain: "inventory", implementorCount: 1, conforms: true, violationCount: 0 },
    ],
  }));
  return {
    client: { submitReviewNotes, fetchRawDomains, ...overrides } as unknown as AnatomiaDomainClient,
    submitReviewNotes,
    fetchRawDomains,
  };
}

function setup(input: { anatomia?: ReturnType<typeof stubAnatomia>; replyAllowed?: boolean; now?: () => number } = {}) {
  const posts = new DomainReviewRepo(makeTestDb());
  const anatomia = input.anatomia ?? stubAnatomia();
  const delivery = new DomainReviewNoteDelivery({
    posts,
    anatomia: anatomia.client,
    log: { info: () => undefined, warn: () => undefined },
    isReplyAuthorAllowed: () => input.replyAllowed === true,
    ...(input.now ? { now: input.now } : {}),
  });
  const post = posts.recordPost({
    code: "Cc",
    repoPath: "E:/Document/Ars/Concordia",
    anatomiaProjectId: "concordia",
    planTaskHash: null,
    triggerKind: "manual",
    platform: "discord",
    channelId: "chan-1",
    messageId: "msg-1",
    questions: [],
  });
  const answer = (text: string, source = "discord:c/r1") => posts.recordAnswer({
    postId: post.id,
    kind: "domain-note",
    answeredBy: "discord:author",
    answerText: text,
    source,
    planAppended: false,
  });
  return { posts, anatomia, delivery, post, answer };
}

describe("DomainReviewNoteDelivery.deliver", () => {
  it("先頭指定でドメインが決まれば review-notes へ送り、proposalId を台帳に残す", async () => {
    const { posts, anatomia, delivery, post, answer } = setup();
    const row = answer("combat: ダメージ計算は武器側");

    const outcome = await delivery.deliver(post, row);

    expect(outcome).toEqual({ status: "sent", answerId: row.id, domainId: "combat", proposalId: "p-1" });
    expect(anatomia.submitReviewNotes).toHaveBeenCalledWith("concordia", [{
      domainId: "combat",
      note: "ダメージ計算は武器側",
      reviewRef: noteReviewRef(row.id),
      kind: "other",
    }]);
    expect(posts.findNoteDelivery(row.id)).toMatchObject({ status: "sent", domain_id: "combat", proposal_id: "p-1", attempts: 1 });
  });

  it("決まらなければ送らず選択待ちにし、ドメインとプロジェクト全体の選択肢を返す", async () => {
    const { posts, anatomia, delivery, post, answer } = setup();
    const row = answer("境界がおかしい");

    const outcome = await delivery.deliver(post, row);

    expect(outcome).toMatchObject({ status: "awaiting_choice", answerId: row.id, omitted: 0 });
    if (outcome.status !== "awaiting_choice") return;
    expect(outcome.choices.map((choice) => choice.value)).toEqual(["combat", "inventory", NOTE_DOMAIN_PROJECT_WIDE]);
    expect(anatomia.submitReviewNotes).not.toHaveBeenCalled();
    expect(posts.findNoteDelivery(row.id)?.status).toBe("awaiting_choice");
  });

  it("ドメイン一覧が取れなければ全体として送らず、未送信と理由を台帳に残す", async () => {
    const anatomia = stubAnatomia({ fetchRawDomains: vi.fn(async () => ({ ok: false, reason: "unreachable" })) });
    const { posts, delivery, post, answer } = setup({ anatomia });
    const row = answer("combat: 何か");

    const outcome = await delivery.deliver(post, row);

    expect(outcome).toEqual({ status: "failed", answerId: row.id, reason: "domains_unavailable:unreachable" });
    expect(anatomia.submitReviewNotes).not.toHaveBeenCalled();
    expect(posts.findNoteDelivery(row.id)).toMatchObject({ status: "failed", reason: "domains_unavailable:unreachable" });
  });

  it("送信に失敗したら理由を残し、同じ返信の再配送で再送できる", async () => {
    const submitReviewNotes = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: true, data: { proposals: [{ proposalId: "p-2", affectedDomainIds: [] }], rejected: [] } });
    const anatomia = stubAnatomia({ submitReviewNotes });
    const { posts, delivery, post, answer } = setup({ anatomia });
    const row = answer("combat: 何か");

    expect(await delivery.deliver(post, row)).toEqual({ status: "failed", answerId: row.id, reason: "anatomia_unreachable" });
    expect(await delivery.deliver(post, row)).toMatchObject({ status: "sent", proposalId: "p-2" });
    expect(posts.findNoteDelivery(row.id)?.attempts).toBe(2);
  });

  it("Anatomia の rejected は理由付きで残し、再配送しても再送しない", async () => {
    const submitReviewNotes = vi.fn(async () => ({
      ok: true,
      data: { proposals: [], rejected: [{ index: 0, reviewRef: "x", reason: "unknown_domain" }] },
    }));
    const anatomia = stubAnatomia({ submitReviewNotes });
    const { delivery, post, answer } = setup({ anatomia });
    const row = answer("combat: 何か");

    expect(await delivery.deliver(post, row)).toEqual({ status: "rejected", answerId: row.id, domainId: "combat", reason: "unknown_domain" });
    await delivery.deliver(post, row);
    expect(submitReviewNotes).toHaveBeenCalledTimes(1);
  });

  it("送信済みの回答は再配送で再送しない", async () => {
    const { anatomia, delivery, post, answer } = setup();
    const row = answer("combat: 何か");
    await delivery.deliver(post, row);
    expect(await delivery.deliver(post, row)).toMatchObject({ status: "sent", proposalId: "p-1" });
    expect(anatomia.submitReviewNotes).toHaveBeenCalledTimes(1);
  });
});

describe("DomainReviewNoteDelivery.choose", () => {
  it("返信者本人がドメインを選ぶと本文全体をそのドメインへ送る", async () => {
    const { anatomia, delivery, post, answer } = setup();
    const row = answer("境界がおかしい");
    await delivery.deliver(post, row);

    const result = await delivery.choose({ answerId: row.id, choice: "inventory", platform: "discord", actorId: "author" });

    expect(result).toEqual({ ok: true, outcome: { status: "sent", answerId: row.id, domainId: "inventory", proposalId: "p-1" } });
    expect(anatomia.submitReviewNotes).toHaveBeenCalledWith("concordia", [{
      domainId: "inventory",
      note: "境界がおかしい",
      reviewRef: noteReviewRef(row.id),
      kind: "other",
    }]);
  });

  it("プロジェクト全体を選ぶと domainId 無しで送る", async () => {
    const { anatomia, delivery, post, answer, posts } = setup();
    const row = answer("全体の命名が揺れている");
    await delivery.deliver(post, row);

    await delivery.choose({ answerId: row.id, choice: NOTE_DOMAIN_PROJECT_WIDE, platform: "discord", actorId: "author" });

    expect(anatomia.submitReviewNotes).toHaveBeenCalledWith("concordia", [{
      note: "全体の命名が揺れている",
      reviewRef: noteReviewRef(row.id),
      kind: "other",
    }]);
    expect(posts.findNoteDelivery(row.id)).toMatchObject({ project_wide: 1, domain_id: null, chosen_by: "discord:author" });
  });

  it("本人でも回答権限者でもない人は選べない", async () => {
    const { anatomia, delivery, post, answer } = setup({ replyAllowed: false });
    const row = answer("境界がおかしい");
    await delivery.deliver(post, row);

    expect(await delivery.choose({ answerId: row.id, choice: "combat", platform: "discord", actorId: "someone" }))
      .toEqual({ ok: false, reason: "forbidden" });
    expect(anatomia.submitReviewNotes).not.toHaveBeenCalled();
  });

  it("回答権限者は本人でなくても選べる", async () => {
    const { delivery, post, answer } = setup({ replyAllowed: true });
    const row = answer("境界がおかしい");
    await delivery.deliver(post, row);
    expect(await delivery.choose({ answerId: row.id, choice: "combat", platform: "discord", actorId: "manager" }))
      .toMatchObject({ ok: true, outcome: { status: "sent" } });
  });

  it("二重クリックしても送信は 1 回", async () => {
    const { anatomia, delivery, post, answer } = setup();
    const row = answer("境界がおかしい");
    await delivery.deliver(post, row);

    const [first, second] = await Promise.all([
      delivery.choose({ answerId: row.id, choice: "combat", platform: "discord", actorId: "author" }),
      delivery.choose({ answerId: row.id, choice: "inventory", platform: "discord", actorId: "author" }),
    ]);

    expect(anatomia.submitReviewNotes).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: true, outcome: { status: "sent", domainId: "combat" } });
    expect(second).toMatchObject({ ok: true });
  });

  it("空の選択値は送らない", async () => {
    const { delivery, post, answer } = setup();
    const row = answer("境界がおかしい");
    await delivery.deliver(post, row);
    expect(await delivery.choose({ answerId: row.id, choice: " ", platform: "discord", actorId: "author" }))
      .toEqual({ ok: false, reason: "invalid_choice" });
  });
});

describe("DomainReviewNoteDelivery.retry", () => {
  it("選択後の送信失敗は同じ宛先で再送する", async () => {
    const submitReviewNotes = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: true, data: { proposals: [{ proposalId: "p-3", affectedDomainIds: [] }], rejected: [] } });
    const anatomia = stubAnatomia({ submitReviewNotes });
    const { delivery, post, answer } = setup({ anatomia });
    const row = answer("境界がおかしい");
    await delivery.deliver(post, row);
    await delivery.choose({ answerId: row.id, choice: NOTE_DOMAIN_PROJECT_WIDE, platform: "discord", actorId: "author" });

    expect(await delivery.retry(row.id)).toEqual({
      ok: true,
      outcome: { status: "sent", answerId: row.id, domainId: null, proposalId: "p-3" },
    });
    expect(submitReviewNotes).toHaveBeenLastCalledWith("concordia", [{
      note: "境界がおかしい",
      reviewRef: noteReviewRef(row.id),
      kind: "other",
    }]);
  });

  it("止まった送信中 (猶予超過) は取り戻して再送し、猶予内は送らない", async () => {
    let now = 1_000_000;
    const { posts, anatomia, delivery, answer } = setup({ now: () => now });
    const row = answer("combat: 何か");
    posts.claimNoteDelivery(row.id, { domainId: "combat", projectWide: false, chosenBy: null }, () => true);
    now = (posts.findNoteDelivery(row.id)?.updated_at ?? 0) + 1_000;

    expect(await delivery.retry(row.id)).toEqual({ ok: true, outcome: { status: "sending", answerId: row.id } });
    expect(anatomia.submitReviewNotes).not.toHaveBeenCalled();

    now += NOTE_DELIVERY_STALE_MS;
    expect(await delivery.retry(row.id)).toMatchObject({ ok: true, outcome: { status: "sent" } });
  });

  it("domain-note 以外・存在しない回答は理由を返す", async () => {
    const { posts, delivery, post } = setup();
    const plan = posts.recordAnswer({
      postId: post.id,
      kind: "plan-question",
      answeredBy: "discord:a",
      answerText: "回答",
      source: "discord:c/plan",
      planAppended: false,
    });
    expect(await delivery.retry(plan.id)).toEqual({ ok: false, reason: "not_a_domain_note" });
    expect(await delivery.retry(9_999)).toEqual({ ok: false, reason: "answer_not_found" });
  });
});
