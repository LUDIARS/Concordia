import { createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { validMeetingIdentity, canIssueMeetingLink, MEETING_LINK_LIFETIME_MS, type MeetingLinkIdentity } from "./policy.js";
export type { MeetingLinkIdentity } from "./policy.js";
export { MEETING_LINK_LIFETIME_MS } from "./policy.js";
interface StoredLink { identity_json: string; expires_at: number }
const digest = (code: string): string => createHash("sha256").update(code).digest("hex");

/** SQLite makes one-time redemption atomic across the backend and standalone chat worker. */
export class MeetingLinkStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS discord_meeting_handoff (
      token_hash TEXT PRIMARY KEY, identity_json TEXT NOT NULL,
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS discord_meeting_handoff_expiry ON discord_meeting_handoff(expires_at);
    CREATE INDEX IF NOT EXISTS discord_meeting_handoff_member ON discord_meeting_handoff(guild_id,user_id,created_at);`);
  }
  issue(identity: MeetingLinkIdentity): string {
    if (!validMeetingIdentity(identity)) {
      throw new Error("Invalid meeting link identity");
    }
    return this.db.transaction(() => {
      const now = this.now();
      this.db.prepare("DELETE FROM discord_meeting_handoff WHERE expires_at<=?").run(now);
      const active = this.db.prepare("SELECT COUNT(*) AS count FROM discord_meeting_handoff").get() as { count: number };
      const recent = this.db.prepare("SELECT COUNT(*) AS count FROM discord_meeting_handoff WHERE guild_id=? AND user_id=? AND created_at>?")
        .get(identity.guildId, identity.discordUserId, now - 60000) as { count: number };
      if (!canIssueMeetingLink(active.count, recent.count)) throw new Error("Meeting link issuance limit reached; retry later");
      const code = randomBytes(32).toString("base64url");
      this.db.prepare("INSERT INTO discord_meeting_handoff VALUES(?,?,?,?,?,?,?)")
        .run(digest(code), JSON.stringify(identity), identity.guildId, identity.discordUserId, identity.meetingId, now, now + MEETING_LINK_LIFETIME_MS);
      return code;
    })();
  }
  peek(code: string, meetingId: string, audience: string): MeetingLinkIdentity | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    const row = this.db.prepare("SELECT identity_json,expires_at FROM discord_meeting_handoff WHERE token_hash=? AND expires_at>?")
      .get(digest(code), this.now()) as StoredLink | undefined;
    if (!row) return null;
    const identity = JSON.parse(row.identity_json) as MeetingLinkIdentity;
    return identity.meetingId === meetingId && identity.audience === audience ? identity : null;
  }
  consume(code: string, meetingId: string, audience: string): MeetingLinkIdentity | null {
    return this.db.transaction(() => {
      const identity = this.peek(code, meetingId, audience);
      if (!identity) return null;
      const result = this.db.prepare("DELETE FROM discord_meeting_handoff WHERE token_hash=? AND expires_at>?").run(digest(code), this.now());
      return result.changes === 1 ? identity : null;
    })();
  }
}
