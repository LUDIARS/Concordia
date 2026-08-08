import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionMessagesRepo } from "./session-messages-repo.js";

let db: ReturnType<typeof makeTestDb>;
let repo: SessionMessagesRepo;

beforeEach(() => {
  db = makeTestDb();
  repo = new SessionMessagesRepo(db);
});

describe("SessionMessagesRepo / upsert", () => {
  it("inserts a new row when dedupe_key is unseen", () => {
    const { row, op } = repo.upsert({
      session_id: "s1",
      ts: 100,
      author_type: "user",
      author_label: "User",
      content: "hello",
      dedupe_key: "frame:1",
    });
    expect(op).toBe("create");
    expect(row.content).toBe("hello");
    expect(row.edited_ts).toBeNull();
  });

  it("is idempotent: re-upsert with same dedupe_key updates the same row (edited_ts set)", () => {
    const first = repo.upsert({
      session_id: "s1",
      ts: 100,
      author_type: "task",
      author_label: "Task",
      content: "running",
      dedupe_key: "task:tool-1",
    });
    const second = repo.upsert({
      session_id: "s1",
      ts: 200,
      author_type: "task",
      author_label: "Task",
      content: "completed",
      dedupe_key: "task:tool-1",
    });
    expect(second.op).toBe("update");
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.content).toBe("completed");
    expect(second.row.edited_ts).toBe(200);
    expect(repo.list("s1")).toHaveLength(1);
  });

  it("Task create → update collapses to a single row (dedupe_key=task:<tool_use_id>)", () => {
    const created = repo.upsert({
      session_id: "s1",
      ts: 100,
      author_type: "task",
      author_label: "Task",
      content: "",
      embeds: [{ title: "Task", fields: [{ name: "status", value: "running" }] }],
      dedupe_key: "task:abc",
    });
    const updated = repo.upsert({
      session_id: "s1",
      ts: 150,
      author_type: "task",
      author_label: "Task",
      content: "result summary",
      embeds: [{ title: "Task", fields: [{ name: "status", value: "completed" }] }],
      dedupe_key: "task:abc",
    });
    expect(updated.row.id).toBe(created.row.id);
    const rows = repo.list("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("result summary");
    expect(rows[0].embeds?.[0]?.fields?.[0]?.value).toBe("completed");
  });

  it("null dedupe_key always inserts a new row (no idempotency)", () => {
    repo.upsert({ session_id: "s1", ts: 1, author_type: "system", author_label: "System", content: "a" });
    repo.upsert({ session_id: "s1", ts: 2, author_type: "system", author_label: "System", content: "b" });
    expect(repo.list("s1")).toHaveLength(2);
  });

  it("dedupe_key uniqueness is scoped per session_id", () => {
    repo.upsert({ session_id: "s1", ts: 1, author_type: "user", author_label: "User", content: "a", dedupe_key: "frame:1" });
    repo.upsert({ session_id: "s2", ts: 1, author_type: "user", author_label: "User", content: "b", dedupe_key: "frame:1" });
    expect(repo.list("s1")).toHaveLength(1);
    expect(repo.list("s2")).toHaveLength(1);
  });
});

describe("SessionMessagesRepo / list pagination", () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) {
      repo.upsert({ session_id: "s1", ts: i, author_type: "user", author_label: "User", content: `m${i}`, dedupe_key: `frame:${i}` });
    }
  });

  it("returns the latest `limit` messages in chronological order when no cursor is given", () => {
    const rows = repo.list("s1", { limit: 2 });
    expect(rows.map((r) => r.content)).toEqual(["m3", "m4"]);
  });

  it("before cursor returns older messages, chronological order", () => {
    const all = repo.list("s1");
    const cursor = all[2].id; // m2
    const rows = repo.list("s1", { before: cursor });
    expect(rows.map((r) => r.content)).toEqual(["m0", "m1"]);
  });

  it("after cursor returns newer messages, ascending order", () => {
    const all = repo.list("s1");
    const cursor = all[1].id; // m1
    const rows = repo.list("s1", { after: cursor });
    expect(rows.map((r) => r.content)).toEqual(["m2", "m3", "m4"]);
  });

  it("clamps limit to the 200 upper bound and defaults to 50", () => {
    const rows = repo.list("s1", { limit: 10_000 });
    expect(rows).toHaveLength(5); // fewer rows than the cap exist
  });
});

describe("SessionMessagesRepo / countAfter, latest, findIdByDedupeKey", () => {
  it("countAfter counts rows with id greater than the given id", () => {
    const a = repo.upsert({ session_id: "s1", ts: 1, author_type: "user", author_label: "User", content: "a" }).row;
    repo.upsert({ session_id: "s1", ts: 2, author_type: "user", author_label: "User", content: "b" });
    repo.upsert({ session_id: "s1", ts: 3, author_type: "user", author_label: "User", content: "c" });
    expect(repo.countAfter("s1", a.id)).toBe(2);
    expect(repo.countAfter("s1", 0)).toBe(3);
  });

  it("latest returns the highest-id row for the session", () => {
    repo.upsert({ session_id: "s1", ts: 1, author_type: "user", author_label: "User", content: "a" });
    const b = repo.upsert({ session_id: "s1", ts: 2, author_type: "user", author_label: "User", content: "b" }).row;
    expect(repo.latest("s1")?.id).toBe(b.id);
  });

  it("findIdByDedupeKey resolves the reference target id, scoped per session", () => {
    const created = repo.upsert({ session_id: "s1", ts: 1, author_type: "tool", author_label: "Tool", content: "x", dedupe_key: "frame:9" }).row;
    expect(repo.findIdByDedupeKey("s1", "frame:9")).toBe(created.id);
    expect(repo.findIdByDedupeKey("s2", "frame:9")).toBeNull();
  });
});

describe("SessionMessagesRepo / listRecentTaskDedupeKeys", () => {
  it("returns only task: dedupe_key rows for the session, newest first", () => {
    repo.upsert({ session_id: "s1", ts: 1, author_type: "user", author_label: "User", content: "x", dedupe_key: "frame:1" });
    repo.upsert({
      session_id: "s1",
      ts: 2,
      author_type: "task",
      author_label: "Task",
      content: "",
      dedupe_key: "task:t1",
      metadata: { tool_use_id: "t1" },
    });
    repo.upsert({
      session_id: "s1",
      ts: 3,
      author_type: "task",
      author_label: "Task",
      content: "",
      dedupe_key: "task:t2",
      metadata: { tool_use_id: "t2" },
    });
    const recent = repo.listRecentTaskDedupeKeys("s1", 10);
    expect(recent.map((r) => r.dedupe_key)).toEqual(["task:t2", "task:t1"]);
    expect(recent[0].metadata?.tool_use_id).toBe("t2");
  });
});

describe("SessionMessagesRepo / JSON deserialization", () => {
  it("treats valid JSON with the wrong container shape as null", () => {
    const created = repo.upsert({
      session_id: "s1",
      ts: 1,
      author_type: "user",
      author_label: "User",
      content: "x",
    }).row;
    db.prepare(
      `UPDATE session_messages SET embeds = ?, components = ?, attachments = ?, metadata = ? WHERE id = ?`,
    ).run('"not-an-array"', "{}", "42", "[]", created.id);

    expect(repo.getById(created.id)).toMatchObject({
      embeds: null,
      components: null,
      attachments: null,
      metadata: null,
    });
  });
});

describe("SessionMessagesRepo / retention", () => {
  it("retains an old message that was edited after the cutoff", () => {
    repo.upsert({
      session_id: "s1",
      ts: 10,
      author_type: "task",
      author_label: "Task",
      content: "running",
      dedupe_key: "task:long-running",
    });
    repo.upsert({
      session_id: "s1",
      ts: 100,
      author_type: "task",
      author_label: "Task",
      content: "complete",
      dedupe_key: "task:long-running",
    });

    expect(repo.purgeOlderThan(50)).toBe(0);
    expect(repo.list("s1")).toHaveLength(1);
  });
});
