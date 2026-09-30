import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrivateChannelsRepo } from "../db/private-channels-repo.js";
import { normalizePrivateChannelName, privateChannelView, requestPrivateChannel } from "./private-channel-request.js";

const NECO = "123456789012345678";

function ports(admin: string | null = NECO) {
  const repo = new PrivateChannelsRepo(makeTestDb());
  const requestProvision = vi.fn();
  return { repo, requestProvision, adminUserId: () => admin, now: () => 10 };
}

describe("requestPrivateChannel", () => {
  it("records a pending channel for the admin when no viewers are given and asks the bot to create it", () => {
    const p = ports();
    const result = requestPrivateChannel(p, { name: "Report for Neco", text: "最初の投稿", session_id: "sess-1" });
    expect(result).toMatchObject({ ok: true, created: true, row: { name: "report-for-neco", status: "pending", initial_text: "最初の投稿" } });
    expect(result.ok && JSON.parse(result.row.viewer_user_ids)).toEqual([NECO]);
    expect(p.requestProvision).toHaveBeenCalledTimes(1);
  });

  it("returns the same record for the same key without creating another (CC-PRIVCH-INV-02)", () => {
    const p = ports();
    const first = requestPrivateChannel(p, { name: "report", key: "k-1" });
    const second = requestPrivateChannel(p, { name: "other", key: "k-1" });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(first.ok && second.ok && second.row.id === first.row.id).toBe(true);
    expect(p.requestProvision).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed viewers, missing viewers, empty names and long text", () => {
    expect(requestPrivateChannel(ports(), { name: "r", viewer_user_ids: ["abc"] })).toEqual({ ok: false, error: "invalid_viewer_user_ids" });
    expect(requestPrivateChannel(ports(), { name: "r", viewer_user_ids: [] })).toEqual({ ok: false, error: "no_viewers" });
    expect(requestPrivateChannel(ports(null), { name: "r" })).toEqual({ ok: false, error: "no_viewers" });
    expect(requestPrivateChannel(ports(), { name: "!!!" })).toEqual({ ok: false, error: "invalid_name" });
    expect(requestPrivateChannel(ports(), { name: "r", text: "あ".repeat(2_001) })).toEqual({ ok: false, error: "invalid_text" });
  });

  it("dedupes viewers", () => {
    const result = requestPrivateChannel(ports(), { name: "r", viewer_user_ids: [NECO, NECO, "223456789012345678"] });
    expect(result.ok && JSON.parse(result.row.viewer_user_ids)).toEqual([NECO, "223456789012345678"]);
  });
});

describe("normalizePrivateChannelName", () => {
  it("follows the Discord channel naming rules", () => {
    expect(normalizePrivateChannelName("  Report for Neco!! ")).toBe("report-for-neco");
    expect(normalizePrivateChannelName("相談 -- 報告")).toBe("相談-報告");
    expect(normalizePrivateChannelName("!!!")).toBe("");
    expect(normalizePrivateChannelName("a".repeat(150))).toHaveLength(100);
  });
});

describe("privateChannelView", () => {
  it("exposes the url only when ready", () => {
    const base = {
      id: "prc_1", request_key: null, name: "r", viewer_user_ids: "[]", initial_text: null, initial_message_id: null,
      guild_id: "g-1", channel_id: "c-1", error: null, created_by_session_id: null, created_at: 1, updated_at: 1,
    };
    expect(privateChannelView({ ...base, status: "ready" }).url).toBe("https://discord.com/channels/g-1/c-1");
    expect(privateChannelView({ ...base, status: "pending" }).url).toBeNull();
  });
});
