import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import {
  classifyEmoji,
  makeChatMessageReactionsRepo,
  makeDiscordConfigRepo,
  makeDiscordMessageMapRepo,
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
} from "./discord-repo.js";

describe("classifyEmoji", () => {
  it("fine / bad / raw に分類", () => {
    expect(classifyEmoji("👍")).toBe("fine");
    expect(classifyEmoji("✅")).toBe("fine");
    expect(classifyEmoji("👎")).toBe("bad");
    expect(classifyEmoji("❌")).toBe("bad");
    expect(classifyEmoji("🤔")).toBe("raw:🤔");
  });
});

describe("discord_config repo", () => {
  it("set/get/all", () => {
    const db = makeTestDb();
    const repo = makeDiscordConfigRepo(db);
    repo.set("guild_id", "g1");
    repo.set("guild_id", "g2"); // upsert
    expect(repo.get("guild_id")).toBe("g2");
    expect(repo.all()).toEqual({ guild_id: "g2" });
    expect(repo.get("missing")).toBeNull();
  });
});

describe("discord_session_channels repo", () => {
  let db: ReturnType<typeof makeTestDb>;
  beforeEach(() => { db = makeTestDb(); });

  it("upsert + find by session/channel + setStatus", () => {
    const repo = makeDiscordSessionChannelsRepo(db);
    repo.upsert({ session_id: "s1", channel_id: "c1" });
    expect(repo.findBySessionId("s1")?.channel_id).toBe("c1");
    expect(repo.findByChannelId("c1")?.session_id).toBe("s1");
    repo.setStatus("s1", "lost");
    expect(repo.findBySessionId("s1")?.status).toBe("lost");
  });

  it("upsert does not replace the first channel for a session", () => {
    const repo = makeDiscordSessionChannelsRepo(db);
    repo.upsert({ session_id: "s1", channel_id: "c1" });
    repo.upsert({ session_id: "s1", channel_id: "c2", status: "lost" });

    expect(repo.findBySessionId("s1")?.channel_id).toBe("c1");
    expect(repo.findByChannelId("c1")?.session_id).toBe("s1");
    expect(repo.findByChannelId("c2")).toBeNull();
    expect(repo.findBySessionId("s1")?.status).toBe("lost");
  });

  it("tryClaimRename は cooldown 内で false / 外で true", () => {
    const repo = makeDiscordSessionChannelsRepo(db);
    repo.upsert({ session_id: "s1", channel_id: "c1" });
    const t0 = 1_000_000;
    expect(repo.tryClaimRename("s1", 300, t0)).toBe(true);
    // 直後の再 claim は cooldown 内
    expect(repo.tryClaimRename("s1", 300, t0 + 100)).toBe(false);
    // cooldown 経過後は OK
    expect(repo.tryClaimRename("s1", 300, t0 + 301)).toBe(true);
  });

  it("setWebhook で webhook を後追い保存", () => {
    const repo = makeDiscordSessionChannelsRepo(db);
    repo.upsert({ session_id: "s1", channel_id: "c1" });
    repo.setWebhook("s1", "wh1", "tk1");
    const row = repo.findBySessionId("s1");
    expect(row?.webhook_id).toBe("wh1");
    expect(row?.webhook_token).toBe("tk1");
  });
});

describe("discord_message_map repo", () => {
  it("put + findChatId", () => {
    const db = makeTestDb();
    const repo = makeDiscordMessageMapRepo(db);
    repo.put("dm1", 42);
    expect(repo.findChatId("dm1")).toBe(42);
    repo.put("dm1", 43); // upsert
    expect(repo.findChatId("dm1")).toBe(43);
    expect(repo.findChatId("nope")).toBeNull();
  });
});

describe("chat_message_reactions repo", () => {
  it("add / remove / countByMessage", () => {
    const db = makeTestDb();
    const repo = makeChatMessageReactionsRepo(db);
    repo.add({ message_id: 1, discord_user_id: "u1", kind: "fine" });
    repo.add({ message_id: 1, discord_user_id: "u2", kind: "fine" });
    repo.add({ message_id: 1, discord_user_id: "u1", kind: "fine" }); // 重複は NO-OP
    repo.add({ message_id: 1, discord_user_id: "u3", kind: "bad" });
    repo.add({ message_id: 1, discord_user_id: "u4", kind: "raw:🤔" });

    expect(repo.countByMessage(1)).toEqual({ fine: 2, bad: 1, other: 1 });

    repo.remove({ message_id: 1, discord_user_id: "u1", kind: "fine" });
    expect(repo.countByMessage(1)).toEqual({ fine: 1, bad: 1, other: 1 });
  });
});

describe("discord_pending_questions repo", () => {
  it("insert / find / markAnswered / findLatestUnanswered", () => {
    const db = makeTestDb();
    const repo = makeDiscordPendingQuestionsRepo(db);
    const q1 = repo.insert({
      session_id: "s1",
      question: "Which option?",
      options: ["A", "B"],
    });
    expect(q1.id).toBeGreaterThan(0);
    expect(repo.findLatestUnanswered("s1")?.id).toBe(q1.id);
    repo.setDiscordMessageId(q1.id, "m-1");
    expect(repo.findById(q1.id)?.discord_message_id).toBe("m-1");
    repo.markAnswered(q1.id, 1, "B");
    const after = repo.findById(q1.id);
    expect(after?.answer_index).toBe(1);
    expect(after?.answer_text).toBe("B");
    expect(after?.answered_at).not.toBeNull();
    expect(repo.findLatestUnanswered("s1")).toBeNull();
  });

  it("markResolvedLocally は answered_at を立て answer_index は null、再回答を弾く準備", () => {
    const db = makeTestDb();
    const repo = makeDiscordPendingQuestionsRepo(db);
    const q = repo.insert({ session_id: "s1", question: "Q", options: ["A", "B"] });
    repo.markResolvedLocally(q.id);
    const after = repo.findById(q.id);
    expect(after?.answered_at).not.toBeNull();
    expect(after?.answer_index).toBeNull();
    expect(after?.answer_text).toBe("(resolved locally)");
    expect(repo.findLatestUnanswered("s1")).toBeNull();
  });

  it("markResolvedLocally は既回答を上書きしない (idempotent)", () => {
    const db = makeTestDb();
    const repo = makeDiscordPendingQuestionsRepo(db);
    const q = repo.insert({ session_id: "s1", question: "Q", options: ["A", "B"] });
    repo.markAnswered(q.id, 0, "A");
    repo.markResolvedLocally(q.id); // WHERE answered_at IS NULL なので no-op
    const after = repo.findById(q.id);
    expect(after?.answer_index).toBe(0);
    expect(after?.answer_text).toBe("A");
  });

  it("findUnansweredByQuestion は同一文の未回答だけ返す (冪等化用)", () => {
    const db = makeTestDb();
    const repo = makeDiscordPendingQuestionsRepo(db);
    const q = repo.insert({ session_id: "s1", question: "進めますか?", options: ["はい", "いいえ"] });
    // 同じ文 → 既存 id を返す (重複投稿防止)
    expect(repo.findUnansweredByQuestion("s1", "進めますか?")?.id).toBe(q.id);
    // 別 session / 別文 → null
    expect(repo.findUnansweredByQuestion("s2", "進めますか?")).toBeNull();
    expect(repo.findUnansweredByQuestion("s1", "別の質問")).toBeNull();
    // 回答済みになったら dedup 対象外 (= 次の同一質問は新規作成される)
    repo.markAnswered(q.id, 0, "はい");
    expect(repo.findUnansweredByQuestion("s1", "進めますか?")).toBeNull();
  });

  it("insert multiSelect + markAnsweredMulti / markAnsweredOther", () => {
    const db = makeTestDb();
    const repo = makeDiscordPendingQuestionsRepo(db);
    const q = repo.insert({
      session_id: "s1",
      question: "どれ?",
      options: ["A", "B", "C"],
      multiSelect: true,
    });
    expect(repo.findById(q.id)?.multi_select).toBe(1);

    // 複数選択回答: answer_index は先頭、answer_indices_json に全 index、answer_text は結合。
    repo.markAnsweredMulti(q.id, [0, 2], "A, C");
    const m = repo.findById(q.id)!;
    expect(m.answered_at).not.toBeNull();
    expect(m.answer_index).toBe(0);
    expect(JSON.parse(m.answer_indices_json!)).toEqual([0, 2]);
    expect(m.answer_text).toBe("A, C");

    // 自由文 (Other) 回答: answer_index は null、answer_text は本文。
    const q2 = repo.insert({ session_id: "s1", question: "自由?", options: ["X"] });
    repo.markAnsweredOther(q2.id, "勝手な文章");
    const o = repo.findById(q2.id)!;
    expect(o.answered_at).not.toBeNull();
    expect(o.answer_index).toBeNull();
    expect(o.answer_text).toBe("勝手な文章");
    expect(o.multi_select).toBe(0);
  });

  it("findRecentlyAnsweredByQuestion は回答後の遅延再 POST を窓内で拾う", () => {
    const db = makeTestDb();
    const repo = makeDiscordPendingQuestionsRepo(db);
    const q = repo.insert({ session_id: "s1", question: "進めますか?", options: ["はい", "いいえ"] });
    // 未回答のうちは null (= こちらは findUnansweredByQuestion が担当)
    expect(repo.findRecentlyAnsweredByQuestion("s1", "進めますか?", 0)).toBeNull();
    repo.markAnswered(q.id, 0, "はい");
    const answeredAt = repo.findById(q.id)!.answered_at!;
    // 窓内 (sinceTs <= answered_at) なら既存 id を返す → transcript-tail の遅延再 POST を弾く
    expect(repo.findRecentlyAnsweredByQuestion("s1", "進めますか?", answeredAt)?.id).toBe(q.id);
    expect(repo.findRecentlyAnsweredByQuestion("s1", "進めますか?", answeredAt - 600)?.id).toBe(q.id);
    // 窓外 (sinceTs > answered_at) なら拾わない
    expect(repo.findRecentlyAnsweredByQuestion("s1", "進めますか?", answeredAt + 1)).toBeNull();
    // 別 session / 別文 → null
    expect(repo.findRecentlyAnsweredByQuestion("s2", "進めますか?", 0)).toBeNull();
    expect(repo.findRecentlyAnsweredByQuestion("s1", "別の質問", 0)).toBeNull();
  });
});
