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

  it("rejects invalid input and invalid transitions with stable status codes", async () => {
    const app = makeApp();
    const invalid = await app.request("/v1/director/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", goal: "x", project: "Cc", steps: [] }),
    });
    expect(invalid.status).toBe(400);

    const created = await createCase(app);
    const conflict = await app.request(
      `/v1/director/cases/${created.caseId}/steps/${created.stepId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
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
