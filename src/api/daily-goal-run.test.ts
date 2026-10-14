import { describe, expect, it, vi } from "vitest";
import { dailyGoalRunRouter } from "./daily-goal-run.js";
import type { DailyGoalRunService } from "../daily-goal-run/service.js";

function setup(overrides: Partial<Record<keyof DailyGoalRunService, unknown>> = {}, opts: { enabled?: boolean; local?: boolean } = {}) {
  const service = {
    list: vi.fn(() => [{ id: "g1" }]),
    detail: vi.fn((id: string) => (id === "g1" ? { goal: { id }, checkpoints: [], timeline: [], card: null } : null)),
    dayDetail: vi.fn((date: string) => ({ day: { businessDate: date, closeState: "posted" }, goals: [], drafts: [] })),
    ...overrides,
  } as unknown as DailyGoalRunService;
  const app = dailyGoalRunRouter(service, { isEnabled: () => opts.enabled ?? true, localRequest: () => opts.local ?? true });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, service, post };
}

describe("daily goal HTTP", () => {
  it("lists and reads goals", async () => {
    const { app } = setup();
    expect(await (await app.request("/?date=2026-10-10")).json()).toEqual({ goals: [{ id: "g1" }] });
    expect((await app.request("/?date=bad")).status).toBe(400);
    expect((await app.request("/g1")).status).toBe(200);
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("has no session report routes (2026-10-14 に撤廃)", async () => {
    const { post } = setup();
    expect((await post("/g1/reached", { session_id: "s1", evidence: [] })).status).toBe(404);
    expect((await post("/g1/exhausted", { session_id: "s1", remaining: [] })).status).toBe(404);
    expect((await post("/g1/report", { session_id: "s1", report: "進捗" })).status).toBe(404);
  });

  it("reads the business-day state (目標なし・通知・まとめ・記載)", async () => {
    const { app } = setup();
    expect(await (await app.request("/days/2026-10-10")).json()).toMatchObject({ day: { businessDate: "2026-10-10", closeState: "posted" } });
    expect((await app.request("/days/bad")).status).toBe(400);
  });

  it("has no route that registers, stops a goal or resends the summary", async () => {
    const { post } = setup();
    expect((await post("/", { goal: "x" })).status).toBe(404);
    expect((await post("/g1/stop", {})).status).toBe(404);
    expect((await post("/days/2026-10-10/resend", {})).status).toBe(404);
  });

  it("returns 409 when the workflow is disabled and 403 off loopback", async () => {
    expect((await setup({}, { enabled: false }).app.request("/")).status).toBe(409);
    expect((await setup({}, { local: false }).app.request("/")).status).toBe(403);
  });
});
