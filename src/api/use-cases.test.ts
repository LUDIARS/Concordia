import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UseCaseCorrectionsRepo } from "../db/use-case-corrections-repo.js";
import { UseCasesRepo } from "../db/use-cases-repo.js";
import { UseCaseService } from "../dialogue/use-case-service.js";
import { sessionCorrectionsRouter, useCasesRouter } from "./use-cases.js";

function makeApp(session: { departmentId: string | null | undefined } = { departmentId: "dept-qa" }) {
  const db = makeTestDb();
  const repo = new UseCasesRepo(db);
  const corrections = new UseCaseCorrectionsRepo(db);
  const app = new Hono()
    .route("/v1/use-cases", useCasesRouter({ repo, service: new UseCaseService({ repo }), corrections }))
    .route("/v1/sessions", sessionCorrectionsRouter({
      corrections,
      lookup: {
        sessionDepartmentId: () => session.departmentId,
        department: () => ({ id: "dept-qa", subsidiary_id: "glab", use_case_id: repo.list()[0]?.id ?? null }),
        useCase: (id) => repo.find(id),
      },
    }));
  return { app, repo, corrections };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("useCasesRouter", () => {
  it("lists the formats and creates a use case from one", async () => {
    const { app } = makeApp();
    const formats = await (await app.request("/v1/use-cases/formats")).json() as { formats: Array<{ key: string }> };
    expect(formats.formats.map((format) => format.key)).toEqual(["chores", "qa", "sparring", "research-report"]);

    const created = await app.request("/v1/use-cases", json("POST", { name: "技術相談", slug: "tech-qa", format: "qa" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      use_case: { work_mode: "read-only", use_requester_profile: true, archived: false, format_name: "一問一答 Q&A" },
    });
  });

  it("rejects an unknown format and a duplicate slug", async () => {
    const { app } = makeApp();
    expect((await app.request("/v1/use-cases", json("POST", { name: "x", slug: "x", format: "poem" }))).status).toBe(400);
    await app.request("/v1/use-cases", json("POST", { name: "x", slug: "x", format: "qa" }));
    expect((await app.request("/v1/use-cases", json("POST", { name: "y", slug: "x", format: "qa" }))).status).toBe(409);
  });

  it("edits, archives and deletes use cases", async () => {
    const { app } = makeApp();
    const { use_case } = await (await app.request("/v1/use-cases", json("POST", { name: "x", slug: "x", format: "qa" }))).json() as { use_case: { id: string } };
    const patched = await app.request(`/v1/use-cases/${use_case.id}`, json("PATCH", { pre_data: "参照: spec/architecture/ddd.md" }));
    expect(await patched.json()).toMatchObject({ use_case: { pre_data: "参照: spec/architecture/ddd.md" } });
    expect((await app.request(`/v1/use-cases/${use_case.id}/archive`, json("POST"))).status).toBe(200);
    expect(((await (await app.request("/v1/use-cases")).json()) as { use_cases: unknown[] }).use_cases).toEqual([]);
    expect((await app.request(`/v1/use-cases/${use_case.id}`, json("DELETE"))).status).toBe(200);
  });

  it("manages corrections per use case and company", async () => {
    const { app } = makeApp();
    const { use_case } = await (await app.request("/v1/use-cases", json("POST", { name: "x", slug: "x", format: "qa" }))).json() as { use_case: { id: string } };
    const created = await app.request(`/v1/use-cases/${use_case.id}/corrections`, json("POST", { correction: "集約は小さく", subsidiary_id: null }));
    expect(created.status).toBe(201);
    const { correction } = await created.json() as { correction: { id: string; source: string } };
    expect(correction.source).toBe("webui");

    await app.request(`/v1/use-cases/${use_case.id}/corrections/${correction.id}`, json("PATCH", { active: false }));
    const active = await (await app.request(`/v1/use-cases/${use_case.id}/corrections`)).json() as { corrections: unknown[] };
    expect(active.corrections).toEqual([]);
    const all = await (await app.request(`/v1/use-cases/${use_case.id}/corrections?include_inactive=1&subsidiary_id=hq`)).json() as { corrections: unknown[] };
    expect(all.corrections).toHaveLength(1);
    expect((await app.request(`/v1/use-cases/${use_case.id}/corrections/${correction.id}`, json("DELETE"))).status).toBe(200);
  });
});

describe("sessionCorrectionsRouter", () => {
  it("registers a correction against the session's department use case", async () => {
    const { app, corrections, repo } = makeApp();
    await app.request("/v1/use-cases", json("POST", { name: "x", slug: "x", format: "qa" }));
    const response = await app.request("/v1/sessions/s-1/corrections", json("POST", {
      correction: "境界づけられた文脈で用語を揃えられる", question: "DDD の利点", author: "111", source: "discord",
    }));
    expect(response.status).toBe(201);
    const [useCase] = repo.list();
    expect(corrections.list(useCase!.id)).toMatchObject([{ subsidiary_id: "glab", department_id: "dept-qa", session_id: "s-1" }]);
  });

  it("returns 409 when the session has no department", async () => {
    const { app } = makeApp({ departmentId: null });
    const response = await app.request("/v1/sessions/s-1/corrections", json("POST", { correction: "x" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "session_has_no_department" });
  });
});
