import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema.js";
import { makeSlackMessageMapRepo, type SlackMessageMapRepo } from "./message-map-repo.js";

describe("slack_message_map repo", () => {
  let repo: SlackMessageMapRepo;
  beforeEach(() => {
    const db = new Database(":memory:");
    applyMigrations(db);
    repo = makeSlackMessageMapRepo(db);
  });

  it("put → findChatId で逆引き", () => {
    repo.put("C1", "111.222", 42);
    expect(repo.findChatId("C1", "111.222")).toBe(42);
  });

  it("未登録 / 別チャンネルは null", () => {
    repo.put("C1", "111.222", 42);
    expect(repo.findChatId("C1", "999.000")).toBeNull();
    expect(repo.findChatId("C2", "111.222")).toBeNull();
  });

  it("同一 (channel, ts) の put は chat_message_id を上書き", () => {
    repo.put("C1", "111.222", 42);
    repo.put("C1", "111.222", 99);
    expect(repo.findChatId("C1", "111.222")).toBe(99);
  });
});
