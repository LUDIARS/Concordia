import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeSlackSessionChannelsRepo } from "./session-channels-repo.js";

describe("slack_session_channels repo", () => {
  it("upserts, reverse-lookups, and tracks due archives", () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb(), () => 100);
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "cc-run-s1-session" });
    repo.setHeaderTs("s1", "101.2");

    expect(repo.findBySessionId("s1")).toMatchObject({
      channel_id: "C1",
      header_ts: "101.2",
      created_at: 100,
    });
    expect(repo.findByChannelId("C1")?.session_id).toBe("s1");

    repo.upsert({ session_id: "s1", channel_id: "C2", channel_name: "cc-run-s1-renamed" });
    expect(repo.findBySessionId("s1")).toMatchObject({ channel_id: "C2", header_ts: "101.2" });

    repo.scheduleArchive("s1", 200);
    expect(repo.listDueForArchive(199)).toEqual([]);
    expect(repo.listDueForArchive(200).map((row) => row.session_id)).toEqual(["s1"]);
    repo.markArchived("s1", 201);
    expect(repo.listDueForArchive(999)).toEqual([]);
    expect(repo.findBySessionId("s1")?.archived_at).toBe(201);
  });

  it("enforces one channel id per session mapping", () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb());
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "one" });
    expect(() => repo.upsert({ session_id: "s2", channel_id: "C1", channel_name: "two" }))
      .toThrow();
  });
});
