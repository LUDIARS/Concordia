import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeSlackSessionThreadsRepo, type SlackSessionThreadsRepo } from "./session-threads-repo.js";

describe("slack_session_threads repo", () => {
  let repo: SlackSessionThreadsRepo;
  beforeEach(() => {
    const db = makeTestDb();
    repo = makeSlackSessionThreadsRepo(db);
  });

  it("upsert → findBySessionId / findByThreadTs", () => {
    repo.upsert({ session_id: "s1", channel_id: "C1", thread_ts: "111.222" });
    expect(repo.findBySessionId("s1")?.thread_ts).toBe("111.222");
    expect(repo.findByThreadTs("C1", "111.222")?.session_id).toBe("s1");
    expect(repo.findByThreadTs("C1", "999.000")).toBeNull();
  });

  it("upsert は session_id 一意（thread_ts を更新）", () => {
    repo.upsert({ session_id: "s1", channel_id: "C1", thread_ts: "1.1" });
    repo.upsert({ session_id: "s1", channel_id: "C1", thread_ts: "2.2" });
    expect(repo.findBySessionId("s1")?.thread_ts).toBe("2.2");
  });

  it("setStatus で ended に遷移", () => {
    repo.upsert({ session_id: "s1", channel_id: "C1", thread_ts: "1.1" });
    repo.setStatus("s1", "ended");
    expect(repo.findBySessionId("s1")?.status).toBe("ended");
  });
});
