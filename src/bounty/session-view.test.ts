import { describe, expect, it } from "vitest";
import { bountySessionView } from "./session-view.js";

const base = { id: "sess-1", status: "active", ended_at: null, metadata: null };

describe("bountySessionView (bug-bounty.md §3 §4)", () => {
  it("reads the company and the requester Cc burned into the session metadata", () => {
    expect(bountySessionView({
      ...base,
      metadata: JSON.stringify({ subsidiary_id: "sub_a", discord_requester_user_id: "905235114026467350" }),
    })).toEqual({ id: "sess-1", active: true, companyId: "sub_a", requesterDiscordUserId: "905235114026467350" });
  });

  it("treats a head-office session started from a terminal as having no requester", () => {
    expect(bountySessionView(base)).toEqual({ id: "sess-1", active: true, companyId: null, requesterDiscordUserId: null });
    expect(bountySessionView({ ...base, metadata: "{broken" }))
      .toMatchObject({ companyId: null, requesterDiscordUserId: null });
    expect(bountySessionView({ ...base, metadata: JSON.stringify({ discord_requester_user_id: 42 }) }).requesterDiscordUserId)
      .toBeNull();
  });

  it("accepts every running session, including one waiting on a human", () => {
    expect(bountySessionView({ ...base, status: "blocked" }).active).toBe(true);
  });

  it.each(["ended", "lost", "abandoned"])("does not accept a %s session", (status) => {
    expect(bountySessionView({ ...base, status }).active).toBe(false);
  });

  it("does not accept a session with an end time even if its status lags", () => {
    expect(bountySessionView({ ...base, ended_at: 1_790_000_000 }).active).toBe(false);
  });
});
