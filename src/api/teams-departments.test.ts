import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DepartmentsRepo } from "../db/departments-repo.js";
import { TeamsRepo } from "../db/teams-repo.js";
import { EMPTY_DEPARTMENT_SETTINGS } from "../departments/settings.js";
import { parseConcordiaEvent } from "../shared/event-schema.js";
import { teamsRouter } from "./teams.js";

// チームの所属部署 (spec/feature/departments.md §3 CC-DEPT-INV-07) と部署の変更イベントの形。
describe("teams department assignment", () => {
  function makeApp() {
    const db = makeTestDb();
    const teams = new TeamsRepo(db);
    const departments = new DepartmentsRepo(db);
    const app = new Hono().route("/v1/teams", teamsRouter(teams, undefined, undefined, departments));
    return { app, teams, departments };
  }
  const send = (method: string, body: unknown): RequestInit => ({
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("assigns a team to an active department of the same organization", async () => {
    const { app, departments } = makeApp();
    const dev = departments.create({ subsidiary_id: null, name: "開発部", slug: "dev", settings: EMPTY_DEPARTMENT_SETTINGS });
    const created = await app.request("/v1/teams", send("POST", { name: "Cc", slug: "cc", department_id: dev.id }));
    expect(created.status).toBe(201);
    const { team } = await created.json() as { team: { id: string; department_id: string } };
    expect(team.department_id).toBe(dev.id);

    const cleared = await app.request(`/v1/teams/${team.id}`, send("PATCH", { department_id: null }));
    expect(await cleared.json()).toMatchObject({ team: { department_id: null } });
  });

  it("rejects departments from another organization, archived or unknown", async () => {
    const { app, departments } = makeApp();
    const child = departments.create({ subsidiary_id: "glab", name: "開発部", slug: "dev", settings: EMPTY_DEPARTMENT_SETTINGS });
    const old = departments.create({ subsidiary_id: null, name: "旧部", slug: "old", settings: EMPTY_DEPARTMENT_SETTINGS });
    departments.setArchived(old.id, true);

    const foreign = await app.request("/v1/teams", send("POST", { name: "a", slug: "a", department_id: child.id }));
    expect(await foreign.json()).toEqual({ error: "department_not_owned_by_requested_organization" });
    const archived = await app.request("/v1/teams", send("POST", { name: "b", slug: "b", department_id: old.id }));
    expect(await archived.json()).toEqual({ error: "department_archived" });
    const unknown = await app.request("/v1/teams", send("POST", { name: "c", slug: "c", department_id: "dept_missing" }));
    expect(await unknown.json()).toEqual({ error: "department_not_found" });
  });
});

describe("department.changed event", () => {
  it("is a known, validated event type", () => {
    expect(parseConcordiaEvent({
      type: "department.changed", event_id: "e1", department_id: "dept-dev", subsidiary_id: null,
      action: "created", fields: ["name"], ts: 1,
    })).toMatchObject({ ok: true });
    expect(parseConcordiaEvent({
      type: "department.changed", event_id: "e1", department_id: "dept-dev", subsidiary_id: null,
      action: "exploded", fields: [], ts: 1,
    })).toMatchObject({ ok: false });
  });
});
