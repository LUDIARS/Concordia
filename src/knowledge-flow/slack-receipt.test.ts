import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createArticleInbox } from "./slack-receipt.js";
it("stores only allowed links, preserves parent and distinguishes redelivery from repost", () => {
    const db = new Database(":memory:");
    try {
        const save = createArticleInbox(db, ["T/C"]);
        const msg = { channel: "C", ts: "2", thread_ts: "1", user: "U", text: "<https://example.org/a#b|article>" };
        save("other", "0", msg, null);
        save("T", "1", msg, null);
        save("T", "1", msg, null);
        save("T", "2", { ...msg, ts: "3" }, null);
        save("T", "3", { channel: "C", subtype: "message_changed", previous_message: msg,
            message: { ...msg, text: msg.text + " https://example.org/b" } }, null);
        expect(db.prepare("SELECT url FROM knowledge_flow_articles ORDER BY id").all()).toEqual([
            { url: "https://example.org/a" }, { url: "https://example.org/b" }
        ]);
        expect(db.prepare("SELECT id,thread FROM knowledge_flow_notifications ORDER BY rowid").all()).toEqual([
            {id:"receipt-1",thread:"1"}, {id:"duplicate-2",thread:"1"}, {id:"receipt-3",thread:"1"}
        ]);
        expect(db.prepare("SELECT duplicate,thread_ts FROM knowledge_flow_receipts ORDER BY event_id").all()).toEqual([
            { duplicate: 0, thread_ts: "1" }, { duplicate: 1, thread_ts: "1" }, { duplicate: 0, thread_ts: "1" }
        ]);
    }
    finally {
        db.close();
    }
});
