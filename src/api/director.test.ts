import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { DirectorRepo } from "../director/repo.js";
import { DirectorService } from "../director/service.js";
import type { GeniusClient } from "../inquiry/genius-client.js";
import { directorRouter } from "./director.js";

describe("directorRouter", () => {
  it("creates and reads a Director case", async () => {
    const app = makeApp();
    const created = await app.request("/v1/director/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "原稿フロー",
        goal: "API 契約を固定する",
        project: "Cc",
        steps: [{ kind: "review", title: "レビュー" }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { case: { id: string }; steps: unknown[] };
    expect(createdBody.steps).toHaveLength(1);

    const detail = await app.request(`/v1/director/cases/${createdBody.case.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ case: { title: "原稿フロー" } });
  });

  it("lists cases with steps and filters them by team", async () => {
    const app = makeApp();
    await app.request("/v1/director/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "チーム案件",
        goal: "kanban を出す",
        project: "Cc",
        team_id: "team-1",
        steps: [{ kind: "implement", title: "実装" }],
      }),
    });
    await createCase(app); // team 無所属の case

    const all = await app.request("/v1/director/cases");
    expect(((await all.json()) as { cases: unknown[] }).cases).toHaveLength(2);

    const filtered = await app.request("/v1/director/cases?team_id=team-1");
    const body = await filtered.json() as {
      cases: Array<{ case: { team_id: string }; steps: Array<Record<string, unknown>> }>;
    };
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0].case.team_id).toBe("team-1");
    expect(body.cases[0].steps).toHaveLength(1);
    expect(body.cases[0].steps[0]).toEqual({
      id: expect.any(String),
      sequence: 1,
      kind: "implement",
      title: "実装",
      status: "pending",
    });
  });

  it("rejects invalid input and invalid transitions with stable status codes", async () => {
    const app = makeApp();
    const invalid = await app.request("/v1/director/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", goal: "x", project: "Cc", steps: [] }),
    });
    expect(invalid.status).toBe(400);

    const created = await createCase(app);
    // pending → completed は「実態完了」として許可される。 terminal からの巻き戻しだけが 409。
    const completed = await app.request(
      `/v1/director/cases/${created.caseId}/steps/${created.stepId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      },
    );
    expect(completed.status).toBe(200);

    const conflict = await app.request(
      `/v1/director/cases/${created.caseId}/steps/${created.stepId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "invalid_transition" });
  });

  it("blocks authority decisions when Genius is unavailable", async () => {
    const app = makeApp();
    const created = await createCase(app);
    const response = await app.request(
      `/v1/director/cases/${created.caseId}/steps/${created.stepId}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "authority",
          question: "この操作を実行してよいか",
          facts: ["Genius unavailable"],
          options: ["実行する", "待つ"],
          impact: "権限境界に影響する",
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      decision: { decision: "ask_human", genius_available: false },
      step: { status: "blocked" },
    });
  });

  it("rejects option sets that cannot be represented by one Discord question", async () => {
    const app = makeApp();
    const created = await createCase(app);
    const response = await app.request(
      `/v1/director/cases/${created.caseId}/steps/${created.stepId}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "authority",
          question: "選択肢上限を検査する",
          facts: [],
          options: Array.from({ length: 26 }, (_, index) => `option-${index}`),
          impact: "Discord カードの index 対応に影響する",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_decision" });
  });

  it("appends a step to an existing case with a tail sequence", async () => {
    const app = makeApp();
    const created = await createCase(app);
    const response = await app.request(`/v1/director/cases/${created.caseId}/steps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "delegate",
        title: "Memoria #12 を実装する",
        handoff_note: "Memoria #12: タスク整理からの追加",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { step: { sequence: number; status: string; kind: string } };
    expect(body.step).toMatchObject({ kind: "delegate", status: "pending", sequence: 2 });

    const detail = await app.request(`/v1/director/cases/${created.caseId}`);
    const detailBody = await detail.json() as { steps: unknown[] };
    expect(detailBody.steps).toHaveLength(2);
  });

  it("rejects step appends to an unknown case or with an invalid body", async () => {
    const app = makeApp();
    const notFound = await app.request("/v1/director/cases/dir_missing/steps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "delegate", title: "どこにも入らない" }),
    });
    expect(notFound.status).toBe(404);

    const created = await createCase(app);
    const invalid = await app.request(`/v1/director/cases/${created.caseId}/steps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "not-a-kind", title: "" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_step" });
  });
});

function makeApp(): Hono {
  const db = new Database(":memory:");
  applyMigrations(db);
  const genius: GeniusClient = { query: async () => null };
  const service = new DirectorService({
    repo: new DirectorRepo(db),
    genius,
    scoreMin: 0.8,
    now: () => 1_730_000_000_000,
  });
  return new Hono().route("/v1/director", directorRouter({ service }));
}

async function createCase(app: Hono): Promise<{ caseId: string; stepId: string }> {
  const response = await app.request("/v1/director/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "原稿フロー",
      goal: "API 契約を固定する",
      project: "Cc",
      steps: [{ kind: "review", title: "レビュー" }],
    }),
  });
  const body = await response.json() as { case: { id: string }; steps: Array<{ id: string }> };
  return { caseId: body.case.id, stepId: body.steps[0].id };
}
