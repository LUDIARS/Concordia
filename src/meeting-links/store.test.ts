import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { MeetingLinkStore, MEETING_LINK_LIFETIME_MS } from "./store.js";
const identity = { meetingId: "7395f8d0-a6b6-4c44-808b-24e3073dc777", guildId: "1136199339417534606",
  discordUserId: "123456789012345678", displayName: "回答者", audience: "https://example.test" };
describe("meeting capabilities", () => {
  it("binds audience and meeting and permits only one consumer across store instances", () => {
    const db = new Database(":memory:");
    try {
      const store = new MeetingLinkStore(db, () => 1000); const second = new MeetingLinkStore(db, () => 1000);
      const code = store.issue(identity);
      expect(store.consume(code, "other", identity.audience)).toBeNull();
      expect(store.consume(code, identity.meetingId, "https://other.test")).toBeNull();
      expect(second.consume(code, identity.meetingId, identity.audience)).toEqual(identity);
      expect(store.consume(code, identity.meetingId, identity.audience)).toBeNull();
    } finally { db.close(); }
  });
  it("expires at the exact boundary and never persists the raw code", () => {
    const db = new Database(":memory:"); let now = 0;
    try {
      const store = new MeetingLinkStore(db, () => now); const code = store.issue(identity);
      expect(JSON.stringify(db.prepare("SELECT * FROM discord_meeting_handoff").all())).not.toContain(code);
      now = MEETING_LINK_LIFETIME_MS;
      expect(store.consume(code, identity.meetingId, identity.audience)).toBeNull();
    } finally { db.close(); }
  });
});
