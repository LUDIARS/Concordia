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

  it("cancelArchive はまだ実行されていない予約を取り消し、以降の due 対象から外す", () => {
    // セッション再開時のシナリオ: archive を予約した後、 archived_at が付く前に
    // cancelArchive すれば sweep の対象から外れる (継続レビュー指摘: セッション
    // 再開時に予約が残ったままだと active なチャンネルが誤って archive される)。
    const repo = makeSlackSessionChannelsRepo(makeTestDb(), () => 100);
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "cc-run-s1-session" });
    repo.scheduleArchive("s1", 200);
    expect(repo.listDueForArchive(200).map((row) => row.session_id)).toEqual(["s1"]);

    repo.cancelArchive("s1");

    expect(repo.listDueForArchive(999)).toEqual([]);
    expect(repo.findBySessionId("s1")).toMatchObject({ archive_due_at: null, archived_at: null });
  });

  it("enforces one channel id per session mapping", () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb());
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "one" });
    expect(() => repo.upsert({ session_id: "s2", channel_id: "C1", channel_name: "two" }))
      .toThrow();
  });
});
