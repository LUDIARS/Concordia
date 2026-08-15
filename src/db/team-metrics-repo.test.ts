import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { SessionsRepo } from "./sessions-repo.js";
import { TeamsRepo } from "./teams-repo.js";
import { TeamMetricsRepo, bucketTeamCostSeries, localMidnightSec } from "./team-metrics-repo.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function seedSession(db: Database.Database, id: string, teamId: string | null, status = "active"): void {
  new SessionsRepo(db).insertSession({
    id,
    provider: "claude-code",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/repo",
    branch: "feat/x",
    host: "host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
    team_id: teamId,
  });
  if (status !== "active") db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
}

function seedCase(db: Database.Database, id: string, teamId: string | null, stepStatuses: string[]): void {
  db.prepare(`
    INSERT INTO director_cases(id, title, goal, project, session_id, team_id, created_at, updated_at)
    VALUES (?, 'case', 'goal', 'repo', NULL, ?, 1, 1)
  `).run(id, teamId);
  stepStatuses.forEach((status, index) => {
    db.prepare(`
      INSERT INTO director_steps(id, case_id, sequence, kind, title, status, task_path, delegation_run_id,
        local_pr_id, confirm_run_id, handoff_note, created_at, updated_at)
      VALUES (?, ?, ?, 'implement', 'step', ?, NULL, NULL, NULL, NULL, NULL, 1, 1)
    `).run(`${id}-s${index}`, id, index + 1, status);
  });
}

function seedSample(db: Database.Database, sessionId: string, ts: number, costTokens: number): void {
  db.prepare(`
    INSERT INTO cost_usage_samples(ts, session_id, subsidiary_id, provider, context_tokens, cost_tokens)
    VALUES (?, ?, NULL, 'claude', NULL, ?)
  `).run(ts, sessionId, costTokens);
}

describe("TeamMetricsRepo", () => {
  it("collects goal / active case / active session counts per team", () => {
    const db = makeDb();
    const team = new TeamsRepo(db).create({ name: "T", slug: "t" });
    seedSession(db, "s-active", team.id);
    seedSession(db, "s-ended", team.id, "ended");
    seedSession(db, "s-other", null);
    seedCase(db, "c-open", team.id, ["completed", "active"]);
    seedCase(db, "c-done", team.id, ["completed"]);
    seedCase(db, "c-unassigned", null, ["pending"]);

    const metrics = new TeamMetricsRepo(db).collect();
    expect(metrics.get(team.id)).toEqual({
      goal_count: 2,
      active_case_count: 1,
      active_session_count: 1,
      today_cost_tokens: 0,
    });
    db.close();
  });

  it("sums today's positive cumulative deltas per team session", () => {
    const db = makeDb();
    const team = new TeamsRepo(db).create({ name: "T", slug: "t" });
    seedSession(db, "s1", team.id);
    seedSession(db, "s2", team.id);
    seedSession(db, "outsider", null);
    const nowMs = new Date(2026, 0, 15, 12).getTime();
    const today = localMidnightSec(nowMs) + 60;
    seedSample(db, "s1", today, 1000);
    seedSample(db, "s1", today + 600, 1500);
    seedSample(db, "s2", today, 200);
    seedSample(db, "s2", today + 600, 300);
    // 集計窓の外 (昨日 / now より未来) は数えない。
    seedSample(db, "s1", localMidnightSec(nowMs) - 600, 100);
    seedSample(db, "s1", Math.floor(nowMs / 1000) + 60, 99_999);
    seedSample(db, "outsider", today, 9999);

    const metrics = new TeamMetricsRepo(db).collect(nowMs);
    expect(metrics.get(team.id)?.today_cost_tokens).toBe(600);
    db.close();
  });

  it("does not overcount today's cost when a session counter resets", () => {
    const db = makeDb();
    const team = new TeamsRepo(db).create({ name: "T", slug: "t" });
    seedSession(db, "s1", team.id);
    const nowMs = new Date(2026, 0, 15, 12).getTime();
    const today = localMidnightSec(nowMs) + 60;
    seedSample(db, "s1", today, 1000);
    seedSample(db, "s1", today + 600, 100);
    seedSample(db, "s1", today + 1200, 300);

    const metrics = new TeamMetricsRepo(db).collect(nowMs);
    expect(metrics.get(team.id)?.today_cost_tokens).toBe(200);
    db.close();
  });

  it("uses reset-safe positive deltas for a single session cost", () => {
    const db = makeDb();
    seedSession(db, "s1", null);
    seedSample(db, "s1", 100, 1000);
    seedSample(db, "s1", 200, 1200);
    seedSample(db, "s1", 300, 100);
    seedSample(db, "s1", 400, 250);

    expect(new TeamMetricsRepo(db).sessionCost("s1")).toBe(350);
    db.close();
  });

  it("builds the team cost series from per-session deltas", () => {
    const db = makeDb();
    const team = new TeamsRepo(db).create({ name: "T", slug: "t" });
    seedSession(db, "s1", team.id);
    seedSample(db, "s1", 3600, 100);
    seedSample(db, "s1", 4200, 250);
    seedSample(db, "s1", 7300, 400);

    const points = new TeamMetricsRepo(db).costSeries(team.id, 0, 3600);
    expect(points).toEqual([
      { ts: 3600, cost_tokens: 150 },
      { ts: 7200, cost_tokens: 150 },
    ]);
    db.close();
  });

  it("uses the last pre-window sample as the cost-series baseline", () => {
    const db = makeDb();
    const team = new TeamsRepo(db).create({ name: "T", slug: "t" });
    seedSession(db, "s1", team.id);
    seedSample(db, "s1", 3500, 100);
    seedSample(db, "s1", 4200, 250);

    const points = new TeamMetricsRepo(db).costSeries(team.id, 3600, 3600);
    expect(points).toEqual([{ ts: 3600, cost_tokens: 150 }]);
    db.close();
  });
});

describe("bucketTeamCostSeries", () => {
  it("ignores negative deltas (session cost counter reset)", () => {
    const points = bucketTeamCostSeries([
      { session_id: "s", ts: 0, cost_tokens: 500 },
      { session_id: "s", ts: 600, cost_tokens: 100 },
      { session_id: "s", ts: 1200, cost_tokens: 250 },
    ], 600);
    expect(points).toEqual([{ ts: 1200, cost_tokens: 150 }]);
  });
});
