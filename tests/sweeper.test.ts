import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { RulesRepo } from "../src/db/rules-repo.js";
import { StatsRepo } from "../src/db/stats-repo.js";
import { TranscriptLogsRepo } from "../src/db/transcript-logs-repo.js";
import { startSweeper } from "../src/sweeper.js";
import { eventBus, type ConcordiaEvent } from "../src/events.js";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
});

function startSession(repo: SessionsRepo, id: string, lastSeenAt: number): void {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "/workspace/project",
    repo_origin: "origin",
    branch: "main",
    host: "host",
    started_at: lastSeenAt,
    last_seen_at: lastSeenAt,
    transcript_path: null,
    metadata: null,
  });
}

describe("sweeper session.lost event", () => {
  it("emits lost once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:30Z"));
    const now = Math.floor(Date.now() / 1000);
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const tasks = new TasksRepo(db);
    const transcriptLogs = new TranscriptLogsRepo(db);
    const rules = new RulesRepo(db);
    const stats = new StatsRepo(db);
    startSession(sessions, "stale-one", now - 100);

    const events: ConcordiaEvent[] = [];
    cleanup.push(eventBus.subscribe((ev) => events.push(ev)));

    const sweeper = startSweeper({
      repo: sessions,
      tasks,
      transcriptLogs,
      rules,
      stats,
      intervalMs: 60_000,
      lostAfterSec: 10,
      abandonedAfterSec: 3_600,
      lostPurgeAfterSec: 3_600,
      purgeAfterDays: 30,
      transcriptRetentionDays: 90,
      rulesLogRetentionDays: 90,
      sessionStatsRetentionDays: 90,
    });
    cleanup.push(sweeper.stop);

    await sweeper.runOnce();
    await sweeper.runOnce();

    expect(events.filter((ev) => ev.type === "session.lost").map((ev) => ev.session_id)).toEqual(["stale-one"]);
    expect(sessions.findSession("stale-one")?.status).toBe("lost");
  });

  it("purges old transcript, rule log, and session stat rows in one pass", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 91 * 86400;
    const recentTs = now - 89 * 86400;
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const tasks = new TasksRepo(db);
    const transcriptLogs = new TranscriptLogsRepo(db);
    const rules = new RulesRepo(db);
    const stats = new StatsRepo(db);

    transcriptLogs.insert({ session_id: "old", seq: 0, ts: oldTs, kind: "text", payload: {} });
    transcriptLogs.insert({ session_id: "recent", seq: 0, ts: recentTs, kind: "text", payload: {} });
    db.prepare(`INSERT INTO rules_log(ts, rule_id, action, actor) VALUES (?, NULL, 'fire', 'engine')`).run(oldTs);
    db.prepare(`INSERT INTO rules_log(ts, rule_id, action, actor) VALUES (?, NULL, 'fire', 'engine')`).run(recentTs);
    stats.insert({ session_id: "old", ts: oldTs, payload: {} });
    stats.insert({ session_id: "recent", ts: recentTs, payload: {} });

    const sweeper = startSweeper({
      repo: sessions,
      tasks,
      transcriptLogs,
      rules,
      stats,
      intervalMs: 60_000,
      lostAfterSec: 1_800,
      abandonedAfterSec: 86_400,
      lostPurgeAfterSec: 1_800,
      purgeAfterDays: 90,
      transcriptRetentionDays: 90,
      rulesLogRetentionDays: 90,
      sessionStatsRetentionDays: 90,
    });
    cleanup.push(sweeper.stop);

    await sweeper.runOnce();

    expect(transcriptLogs.countBySession("old")).toBe(0);
    expect(transcriptLogs.countBySession("recent")).toBe(1);
    expect(rules.recentLogs()).toHaveLength(1);
    expect(stats.history("old")).toHaveLength(0);
    expect(stats.history("recent")).toHaveLength(1);
  });
});
