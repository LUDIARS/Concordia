import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema.js";
import { PersonasRepo } from "../db/personas-repo.js";
import { ChatRepo } from "../db/chat-repo.js";
import { seedPersonas } from "./seeds.js";
import { collectBoyakiToPersona } from "./boyaki.js";

let db: Database.Database;
let personas: PersonasRepo;
let chat: ChatRepo;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  personas = new PersonasRepo(db);
  chat = new ChatRepo(db);
  seedPersonas(personas);
});

afterEach(() => {
  db.close();
});

function postBoyaki(session_id: string | null, author_label: string, text: string) {
  return chat.insert({
    channel: "ぼやき",
    session_id,
    author_label,
    text,
    in_reply_to: null,
    is_actionable: false,
  });
}

describe("collectBoyakiToPersona", () => {
  it("appends a boyaki feedback entry to the author session's persona", () => {
    const a = personas.assign("sess-1");
    expect(a).not.toBeNull();
    const msg = postBoyaki("sess-1", a!.persona.name, "今日もビルドが通らない…");

    collectBoyakiToPersona({ personas, chat }, { message_id: msg.id, session_id: "sess-1" });

    const boyaki = personas.recentFeedback(a!.persona.id, 10).filter((f) => f.kind === "boyaki");
    expect(boyaki).toHaveLength(1);
    expect(boyaki[0].delta).toContain("ビルド");
  });

  it("truncates the muttering to 120 chars", () => {
    const a = personas.assign("sess-long");
    const long = "あ".repeat(300);
    const msg = postBoyaki("sess-long", a!.persona.name, long);

    collectBoyakiToPersona({ personas, chat }, { message_id: msg.id, session_id: "sess-long" });

    const fb = personas.recentFeedback(a!.persona.id, 10).find((f) => f.kind === "boyaki");
    expect(fb?.delta.length).toBe(120);
  });

  it("ignores posts with no session_id (human muttering)", () => {
    const msg = postBoyaki(null, "human", "ひとりごと");
    expect(() =>
      collectBoyakiToPersona({ personas, chat }, { message_id: msg.id, session_id: null }),
    ).not.toThrow();
    expect(personas.recentFeedbackAll(50).filter((f) => f.kind === "boyaki")).toHaveLength(0);
  });

  it("ignores sessions without an active persona assignment", () => {
    const msg = postBoyaki("sess-x", "x", "未割当セッションのぼやき");
    collectBoyakiToPersona({ personas, chat }, { message_id: msg.id, session_id: "sess-x" });
    expect(personas.recentFeedbackAll(50).filter((f) => f.kind === "boyaki")).toHaveLength(0);
  });

  it("does not collect non-boyaki channels (double-guard)", () => {
    const a = personas.assign("sess-2");
    const msg = chat.insert({
      channel: "chitchat",
      session_id: "sess-2",
      author_label: a!.persona.name,
      text: "ただの雑談",
      in_reply_to: null,
      is_actionable: false,
    });
    collectBoyakiToPersona({ personas, chat }, { message_id: msg.id, session_id: "sess-2" });
    expect(personas.recentFeedback(a!.persona.id, 10).filter((f) => f.kind === "boyaki")).toHaveLength(0);
  });
});
