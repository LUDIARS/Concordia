import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrivateChannelsRepo, viewerIdsOf } from "./private-channels-repo.js";

const input = {
  request_key: "report-1",
  name: "report-for-neco",
  viewer_user_ids: ["123456789012345678"],
  initial_text: "最初の投稿",
  created_by_session_id: "sess-1",
};

describe("PrivateChannelsRepo", () => {
  it("records a pending request and finds it by key", () => {
    const repo = new PrivateChannelsRepo(makeTestDb());
    const row = repo.create(input, 1);
    expect(row).toMatchObject({ status: "pending", channel_id: null, name: "report-for-neco" });
    expect(viewerIdsOf(row)).toEqual(["123456789012345678"]);
    expect(repo.findByKey("report-1")?.id).toBe(row.id);
    expect(repo.listPending().map((r) => r.id)).toEqual([row.id]);
  });

  it("marks ready only after the channel is recorded and trusts only ready channels", () => {
    const repo = new PrivateChannelsRepo(makeTestDb());
    const row = repo.create(input, 1);
    repo.recordChannel(row.id, { guild_id: "g-1", channel_id: "c-1" }, 2);
    expect(repo.isReadyChannel("c-1")).toBe(false);
    repo.recordInitialMessage(row.id, "m-1", 3);
    repo.markReady(row.id, 4);
    expect(repo.isReadyChannel("c-1")).toBe(true);
    expect(repo.find(row.id)).toMatchObject({ status: "ready", initial_message_id: "m-1" });
    repo.markFailed(row.id, "late failure", 5);
    expect(repo.find(row.id)?.status).toBe("ready");
  });

  it("keeps a failure reason and leaves failed rows out of the pending list", () => {
    const repo = new PrivateChannelsRepo(makeTestDb());
    const row = repo.create({ ...input, request_key: null }, 1);
    repo.markFailed(row.id, "Missing Permissions", 2);
    expect(repo.find(row.id)).toMatchObject({ status: "failed", error: "Missing Permissions" });
    expect(repo.listPending()).toEqual([]);
  });
});
