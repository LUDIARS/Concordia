import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema.js";
import { ChatRepo } from "../db/chat-repo.js";
import { collectSignals } from "./signals.js";
import type { SessionRow, SessionEventRow } from "../shared/types.js";

let db: Database.Database;
let chat: ChatRepo;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  chat = new ChatRepo(db);
});

afterEach(() => {
  db.close();
});

function ev(id: number, kind: string, payload: object): SessionEventRow {
  return { id, session_id: "s1", ts: 1000 + id, kind, payload: JSON.stringify(payload) };
}

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s1",
    provider: "claude-code",
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: null,
    branch: "feat/x",
    host: "host",
    started_at: 0,
    ended_at: null,
    status: "active",
    last_seen_at: 0,
    current_task: "persona 実装",
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    ...over,
  };
}

describe("collectSignals", () => {
  it("derives role / repo / counts / focus / tools from events", () => {
    const events = [
      ev(1, "prompt", { summary: "やって" }),
      ev(2, "prompt", { summary: "次" }),
      ev(3, "edit", { file: "src/a.test.ts" }),
      ev(4, "edit", { file: "src/b.test.ts" }),
      ev(5, "edit", { file: "tests/c.ts" }),
      ev(6, "tool_call", { tool: "Bash" }),
      ev(7, "tool_call", { tool: "Bash" }),
    ];
    const s = collectSignals({ chat }, session(), events);

    expect(s.repo_base).toBe("Concordia");
    expect(s.role_label).toBe("テスト魂"); // testFileEdits >= 3
    expect(s.prompt_count).toBe(2);
    expect(s.edit_count).toBe(3);
    expect(s.file_focus).toContain("test");
    expect(s.dominant_tools).toContain("Bash");
  });

  it("collects session-scoped voices and chronological chat samples", () => {
    chat.insert({ channel: "chitchat", session_id: "s1", author_label: "境野 詰", text: "古い発言", in_reply_to: null, is_actionable: false });
    chat.insert({ channel: "chitchat", session_id: "s1", author_label: "火盛", text: "新しい発言", in_reply_to: null, is_actionable: false });
    // 別セッションの発言は混ざらない
    chat.insert({ channel: "chitchat", session_id: "other", author_label: "別人", text: "無関係", in_reply_to: null, is_actionable: false });

    const s = collectSignals({ chat }, session(), []);
    expect(s.voices).toEqual(expect.arrayContaining(["境野 詰", "火盛"]));
    expect(s.voices).not.toContain("別人");
    expect(s.chat_samples).toHaveLength(2);
    // 時系列昇順 (古い → 新しい)
    expect(s.chat_samples[0]).toContain("古い発言");
    expect(s.chat_samples[1]).toContain("新しい発言");
  });

  it("falls back to 雑用係 when no pattern matches", () => {
    const s = collectSignals({ chat }, session(), [ev(1, "prompt", {})]);
    expect(s.role_label).toBe("雑用係");
  });
});
