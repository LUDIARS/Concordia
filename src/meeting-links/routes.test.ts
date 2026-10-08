import { afterEach, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { MeetingLinkStore } from "./store.js";
import { meetingLinkRouter } from "./routes.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("rejects revoked membership without consuming, then consumes once after live confirmation", async () => {
  const db = new Database(":memory:");
  try {
    const guildId = "1136199339417534606", audience = "https://example.test", discordUserId = "123456789012345678";
    vi.stubEnv("CONCORDIA_MEETING_LINK_ENABLED", "true");
    vi.stubEnv("CONCORDIA_MEETING_LINK_GUILD_ID", guildId);
    vi.stubEnv("CONCORDIA_MEETING_LINK_PUBLIC_URL", audience);
    const store = new MeetingLinkStore(db);
    const identity = { guildId, audience, discordUserId, meetingId: "7395f8d0-a6b6-4c44-808b-24e3073dc777", displayName: "name" };
    const code = store.issue(identity);
    const fetchMember = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ user: { id: discordUserId }, pending: false }));
    vi.stubGlobal("fetch", fetchMember);
    const app = meetingLinkRouter({ store, botConfig: () => ({ token: "fixture-token", guildId }) });
    const request = () => app.request("/consume", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, meetingId: identity.meetingId, audience }) });
    expect((await request()).status).toBe(403);
    expect(store.peek(code, identity.meetingId, audience)).toEqual(identity);
    const success = await request();
    expect(success.status).toBe(200); expect(success.headers.get("cache-control")).toBe("no-store");
    expect(await success.json()).toEqual(identity);
    expect((await request()).status).toBe(403);
    expect(fetchMember).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});
