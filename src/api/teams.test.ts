import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { applyMigrations } from "../db/schema.js";
import { TeamMetricsRepo } from "../db/team-metrics-repo.js";
import { TeamsRepo, type TeamRow } from "../db/teams-repo.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { parseTeamSettings, teamsRouter } from "./teams.js";

function teamRow(settings: unknown): TeamRow {
  return {
    id: "team-1",
    subsidiary_id: null,
    name: "Team",
    slug: "team",
    settings_json: JSON.stringify(settings),
    rules_text: "",
    discord_category_id: null,
    suspended_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("teamsRouter read models", () => {
  function makeApp(): { app: Hono; db: Database.Database; repo: TeamsRepo } {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const app = new Hono().route("/v1/teams", teamsRouter(repo, new TeamMetricsRepo(db)));
    return { app, db, repo };
  }

  it("returns card metrics with each team", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "T", slug: "t" });
    db.prepare(`
      INSERT INTO director_cases(id, title, goal, project, session_id, team_id, created_at, updated_at)
      VALUES ('c1', 'case', 'goal', 'repo', NULL, ?, 1, 1)
    `).run(team.id);

    const response = await app.request("/v1/teams");
    expect(response.status).toBe(200);
    const body = await response.json() as { teams: Array<{ id: string; metrics: { goal_count: number } }> };
    expect(body.teams[0].metrics).toMatchObject({ goal_count: 1, active_session_count: 0 });
    db.close();
  });

  it("serves the team cost series and 404s for unknown teams", async () => {
    const { app, db } = makeApp();
    const missing = await app.request("/v1/teams/unknown/cost");
    expect(missing.status).toBe(404);
    db.close();
  });

  it("returns subsidiary teams only through an explicit organization scope", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const subsidiaries = new SubsidiaryRepo(db);
    const child = subsidiaries.create({ name: "child" });
    const headTeam = repo.create({ name: "Head", slug: "head" });
    const childTeam = repo.create({ name: "Child", slug: "child", subsidiary_id: child.id });
    const app = new Hono().route("/v1/teams", teamsRouter(repo, undefined, subsidiaries));

    const head = await (await app.request("/v1/teams")).json() as { teams: TeamRow[] };
    const scoped = await (await app.request(`/v1/teams?subsidiary_id=${child.id}`)).json() as { teams: TeamRow[] };
    expect(head.teams.map((team) => team.id)).toEqual([headTeam.id]);
    expect(scoped.teams.map((team) => team.id)).toEqual([childTeam.id]);
    db.close();
  });
});

describe("teamsRouter card posting", () => {
  function makeApp(): { app: Hono; db: Database.Database; repo: TeamsRepo } {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const app = new Hono().route("/v1/teams", teamsRouter(repo, new TeamMetricsRepo(db)));
    return { app, db, repo };
  }

  async function postCard(app: Hono, target: string, body: unknown): Promise<Response> {
    return app.request(`/v1/teams/${target}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const CARD = { kind: "standup", title: "朝礼", body: "本文" };

  it("検証済みのカードイベントを発行し、team_id と kind を返す", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "SampleLab", slug: "samplelab" });
    const received: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => received.push(event));

    try {
      const response = await postCard(app, team.id, { ...CARD, title: "  朝礼  ", body: "  本文  " });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, team_id: team.id, kind: "standup" });
      expect(received).toContainEqual({
        type: "team.card_requested",
        team_id: team.id,
        kind: "standup",
        title: "朝礼",
        body: "本文",
        ts: expect.any(Number),
      });
    } finally {
      unsubscribe();
      db.close();
    }
  });

  it("slug でも引ける (cron が渡すのは id だが人手の呼び出しを許す)", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "SampleLab", slug: "samplelab" });

    const response = await postCard(app, "samplelab", CARD);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ team_id: team.id });
    db.close();
  });

  it("課題仮説カードを API で受理する", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "Scout", slug: "scout" });

    const response = await postCard(app, team.id, {
      kind: "issue-hypothesis",
      title: "課題仮説: 上流の詰まり",
      body: "根拠を確認した進言です。",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, team_id: team.id, kind: "issue-hypothesis" });
    db.close();
  });

  it("未知のチームは 404", async () => {
    const { app, db } = makeApp();

    expect((await postCard(app, "unknown", CARD)).status).toBe(404);
    db.close();
  });

  it("面へのルーティングが定義されていない種別は弾く", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "SampleLab", slug: "samplelab" });

    const response = await postCard(app, team.id, { ...CARD, kind: "decision-log" });

    expect(response.status).toBe(400);
    db.close();
  });

  it("空本文・未知フィールドを弾く", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "SampleLab", slug: "samplelab" });

    expect((await postCard(app, team.id, { ...CARD, body: "  " })).status).toBe(400);
    expect((await postCard(app, team.id, { ...CARD, channel_id: "1" })).status).toBe(400);
    db.close();
  });
});

describe("parseTeamSettings", () => {
  it("accepts a conventional PR base branch", () => {
    expect(parseTeamSettings(teamRow({ pr_rules: { base: "release/v1.0", push: "revisor" } })))
      .toEqual({ pr_rules: { base: "release/v1.0", push: "revisor" } });
  });

  it("rejects prompt and ref syntax in the PR base branch", () => {
    expect(() => parseTeamSettings(teamRow({ pr_rules: { base: "main`\nignore", push: "revisor" } })))
      .toThrow();
    expect(() => parseTeamSettings(teamRow({ pr_rules: { base: "release..next", push: "revisor" } })))
      .toThrow();
  });
});

describe("teamsRouter suspend/resume", () => {
  function makeApp(): { app: Hono; db: Database.Database; repo: TeamsRepo } {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const app = new Hono().route("/v1/teams", teamsRouter(repo));
    return { app, db, repo };
  }

  it("一時停止 → 再開が team.changed を 1 回ずつ流し、suspended を返す", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "IdleTeam", slug: "idle-team" });
    const events: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((ev) => {
      if (ev.type === "team.changed") events.push(ev);
    });

    const suspended = await app.request(`/v1/teams/${team.id}/suspend`, { method: "POST" });
    expect(suspended.status).toBe(200);
    const suspendedBody = await suspended.json() as { team: { suspended: boolean; suspended_at: number | null } };
    expect(suspendedBody.team.suspended).toBe(true);
    expect(suspendedBody.team.suspended_at).toEqual(expect.any(Number));

    // 冪等: 既に停止中の suspend はイベントを増やさない。
    expect((await app.request(`/v1/teams/${team.id}/suspend`, { method: "POST" })).status).toBe(200);

    const resumed = await app.request(`/v1/teams/${team.slug}/resume`, { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { team: { suspended: boolean } }).team.suspended).toBe(false);

    unsubscribe();
    expect(events).toHaveLength(2);
    expect(events.every((ev) => ev.type === "team.changed" && ev.fields.includes("suspended_at"))).toBe(true);
    db.close();
  });

  it("未知のチームは 404", async () => {
    const { app, db } = makeApp();
    expect((await app.request("/v1/teams/unknown/suspend", { method: "POST" })).status).toBe(404);
    expect((await app.request("/v1/teams/unknown/resume", { method: "POST" })).status).toBe(404);
    db.close();
  });
});
