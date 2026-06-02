import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./schema.js";
import {
  classifyEmoji,
  makeChatMessageReactionsRepo,
  makeDiscordConfigRepo,
  makeDiscordMessageMapRepo,
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
} from "./discord-repo.js";

function makeDb() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

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
    const db = makeDb();
    const repo = makeDiscordConfigRepo(db);
    repo.set("guild_id", "g1");
    repo.set("guild_id", "g2"); // upsert
    expect(repo.get("guild_id")).toBe("g2");
    expect(repo.all()).toEqual({ guild_id: "g2" });
    expect(repo.get("missing")).toBeNull();
  });
});

describe("discord_session_channels repo", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("upsert + find by session/channel + setStatus", () => {
    const repo = makeDiscordSessionChannelsRepo(db);
    repo.upsert({ session_id: "s1", channel_id: "c1" });
    expect(repo.findBySessionId("s1")?.channel_id).toBe("c1");
    expect(repo.findByChannelId("c1")?.session_id).toBe("s1");
    repo.setStatus("s1", "lost");
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
    const db = makeDb();
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
    const db = makeDb();
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
    const db = makeDb();
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
    const db = makeDb();
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
    const db = makeDb();
    const repo = makeDiscordPendingQuestionsRepo(db);
    const q = repo.insert({ session_id: "s1", question: "Q", options: ["A", "B"] });
    repo.markAnswered(q.id, 0, "A");
    repo.markResolvedLocally(q.id); // WHERE answered_at IS NULL なので no-op
    const after = repo.findById(q.id);
    expect(after?.answer_index).toBe(0);
    expect(after?.answer_text).toBe("A");
  });
});
