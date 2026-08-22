import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "../../tests/helpers/db.js";
import { EscalationRepo } from "../db/escalation-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TasksRepo } from "../db/tasks-repo.js";
import { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import { ingestEscalationTranscriptRecords } from "./escalation-transcript-intake.js";
import { parseEscalationTranscriptRecord } from "./escalation-transcript-record.js";

function seed(db: Database.Database, id: string): void {
  new SessionsRepo(db).insertSession({
    id,
    provider: "claude-code",
    repo_path: "/work/Concordia",
    repo_origin: null,
    branch: "main",
    host: "host",
    started_at: 1_000,
    last_seen_at: 1_000,
    transcript_path: null,
    metadata: null,
  });
}

function makeDeps(db: Database.Database) {
  const transcriptLogs = new TranscriptLogsRepo(db);
  return {
    sessions: new SessionsRepo(db),
    escalations: new EscalationRepo(db),
    tasks: new TasksRepo(db),
    transcriptLogs,
  };
}

describe("escalation transcript record parsing", () => {
  it("reads reason, start time, and repo from a declaration line", () => {
    const record = parseEscalationTranscriptRecord(
      'ESCALATION start reason="Cc down, cannot register tasks" at=2000 repo=E:/Document/Ars/Concordia',
      9_999,
    );

    expect(record).toEqual({ action: "start", reason: "Cc down, cannot register tasks", at: 2_000, repo: "E:/Document/Ars/Concordia" });
  });

  it("falls back to the frame timestamp when at= is omitted", () => {
    const record = parseEscalationTranscriptRecord('ESCALATION start reason="outage"', 4_242);
    expect(record).toMatchObject({ action: "start", at: 4_242 });
  });

  it("rejects a start declaration with no reason", () => {
    expect(parseEscalationTranscriptRecord("ESCALATION start repo=/work", 10)).toBeNull();
  });

  it("reads the release declaration with its note", () => {
    expect(parseEscalationTranscriptRecord('ESCALATION end at=3000 note="restored"', 10)).toEqual({
      action: "end",
      at: 3_000,
      note: "restored",
    });
  });

  it("ignores text that merely mentions the word", () => {
    expect(parseEscalationTranscriptRecord("we should think about ESCALATION policy later", 10)).toBeNull();
  });
});

describe("escalation transcript intake", () => {
  it("creates a matching escalation event after Cc comes back", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    const deps = makeDeps(db);
    deps.transcriptLogs.insert({
      session_id: "rescuer",
      seq: 1,
      ts: 5_000,
      kind: "text",
      payload: { text: 'ESCALATION start reason="Cc down" at=4900' },
    });

    const result = ingestEscalationTranscriptRecords(deps, { now: 6_000, lookbackSec: 10_000 });

    expect(result.started).toEqual(["rescuer"]);
    const open = deps.escalations.findOpen("rescuer");
    expect(open).toMatchObject({ reason: "Cc down", started_at: 4_900, source: "transcript", actor: "transcript-record" });
  });

  it("is idempotent across ticks", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    const deps = makeDeps(db);
    deps.transcriptLogs.insert({
      session_id: "rescuer",
      seq: 1,
      ts: 5_000,
      kind: "text",
      payload: { text: 'ESCALATION start reason="Cc down" at=4900' },
    });

    ingestEscalationTranscriptRecords(deps, { now: 6_000, lookbackSec: 10_000 });
    const second = ingestEscalationTranscriptRecords(deps, { now: 6_100, lookbackSec: 10_000 });

    expect(second.started).toEqual([]);
    expect(deps.escalations.listBySession("rescuer")).toHaveLength(1);
  });

  it("applies a declaration that was already released, without stopping anyone", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer");
    const deps = makeDeps(db);
    deps.transcriptLogs.insert({
      session_id: "rescuer",
      seq: 1,
      ts: 5_000,
      kind: "text",
      payload: { text: 'ESCALATION start reason="Cc down" at=4900' },
    });
    deps.transcriptLogs.insert({
      session_id: "rescuer",
      seq: 2,
      ts: 5_500,
      kind: "text",
      payload: { text: 'ESCALATION end at=5400 note="restored"' },
    });

    const result = ingestEscalationTranscriptRecords(deps, { now: 6_000, lookbackSec: 10_000 });

    expect(result).toEqual({ started: ["rescuer"], ended: ["rescuer"] });
    expect(deps.escalations.isEscalated("rescuer")).toBe(false);
    // 停止 claim は取り込みの解除で取り下げられ、 遅れて配送されない。
    expect(deps.tasks.pull("peer", 10)).toHaveLength(0);
  });

  it("does not stop peers for a declaration whose release is in the same batch", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer");
    const deps = makeDeps(db);
    deps.transcriptLogs.insert({
      session_id: "rescuer",
      seq: 1,
      ts: 5_000,
      kind: "text",
      payload: { text: 'ESCALATION start reason="Cc down" at=4900' },
    });
    deps.transcriptLogs.insert({
      session_id: "rescuer",
      seq: 2,
      ts: 5_500,
      kind: "text",
      payload: { text: 'ESCALATION end at=5400' },
    });

    ingestEscalationTranscriptRecords(deps, { now: 6_000, lookbackSec: 10_000 });

    // 記録は残るが、 終わった停止で peer を止めることはしない。
    expect(deps.escalations.listBySession("rescuer")).toHaveLength(1);
    expect(deps.tasks.pull("peer", 10)).toHaveLength(0);
  });

  it("skips declarations from sessions that no longer exist", () => {
    const db = makeTestDb();
    const deps = makeDeps(db);
    deps.transcriptLogs.insert({
      session_id: "purged",
      seq: 1,
      ts: 5_000,
      kind: "text",
      payload: { text: 'ESCALATION start reason="Cc down"' },
    });

    expect(ingestEscalationTranscriptRecords(deps, { now: 6_000, lookbackSec: 10_000 }).started).toEqual([]);
  });
});
