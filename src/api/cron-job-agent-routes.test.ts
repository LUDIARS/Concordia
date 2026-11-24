import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { RuntimeSettingsStore } from "../admin/runtime-settings.js";
import { SqliteSettingsStore } from "../admin/settings-store.js";
import type { CronJobDefinition } from "../scheduler/cron-jobs.js";
import { registerCronJobAgentRoutes, serializeCronJobAgent } from "./cron-job-agent-routes.js";

// spec/feature/parttimer-agent-dispatch.md CC-PT-AGENT-INV-06
const jobs: CronJobDefinition[] = [
  { name: "deps-sweep-daily", cron: "0 0 1 1 *", call_name: "deps-sweep-daily", buildArgs: () => ({}) },
  { name: "vulnerability-response-daily", cron: "0 0 1 1 *", call_name: "vulnerability-response-daily", buildArgs: () => ({}) },
];

function setup() {
  const settings = new RuntimeSettingsStore(new SqliteSettingsStore(makeTestDb()));
  const app = new Hono();
  registerCronJobAgentRoutes(app, { jobs, settings });
  const put = (path: string, body: unknown) => app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { settings, app, put };
}

describe("PUT /v1/admin/cron-jobs/:name/agent", () => {
  it("既定は全ジョブ '' (従来の委託) で、 data builder の有無を返す", () => {
    const { settings } = setup();
    expect(serializeCronJobAgent(jobs[0]!, settings)).toEqual({ agent: "", agent_supported: true });
    expect(serializeCronJobAgent(jobs[1]!, settings)).toEqual({ agent: "", agent_supported: false });
  });

  it("data builder のあるジョブは dots へ切り替えられ、 '' で従来へ戻せる", async () => {
    const { settings, put } = setup();
    const res = await put("/v1/admin/cron-jobs/deps-sweep-daily/agent", { agent: "dots" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: { name: "deps-sweep-daily", agent: "dots", agent_supported: true } });
    expect(settings.getCronJobAgent("deps-sweep-daily")).toBe("dots");
    expect((await put("/v1/admin/cron-jobs/deps-sweep-daily/agent", { agent: "" })).status).toBe(200);
    expect(settings.getCronJobAgent("deps-sweep-daily")).toBeNull();
  });

  it("INV-06: data builder の無いジョブを外部エージェントへ切り替える要求は 400 (従来への '' は通す)", async () => {
    const { settings, put } = setup();
    const res = await put("/v1/admin/cron-jobs/vulnerability-response-daily/agent", { agent: "muse" });
    expect(res.status).toBe(400);
    expect(settings.getCronJobAgent("vulnerability-response-daily")).toBeNull();
    expect((await put("/v1/admin/cron-jobs/vulnerability-response-daily/agent", { agent: "" })).status).toBe(200);
  });

  it("不明なジョブは 404、 許可リスト外の宛先・本文なしは 400", async () => {
    const { put } = setup();
    expect((await put("/v1/admin/cron-jobs/nope/agent", { agent: "dots" })).status).toBe(404);
    expect((await put("/v1/admin/cron-jobs/deps-sweep-daily/agent", { agent: "gemini" })).status).toBe(400);
    expect((await put("/v1/admin/cron-jobs/deps-sweep-daily/agent", {})).status).toBe(400);
  });

  it("戻しの分は既定 180 で、 1 以上の整数だけ保存できる", async () => {
    const { app, put } = setup();
    expect(await (await app.request("/v1/admin/cron-jobs-agent-fallback")).json()).toEqual({ minutes: 180 });
    expect((await put("/v1/admin/cron-jobs-agent-fallback", { minutes: 0 })).status).toBe(400);
    expect((await put("/v1/admin/cron-jobs-agent-fallback", { minutes: 1.5 })).status).toBe(400);
    const res = await put("/v1/admin/cron-jobs-agent-fallback", { minutes: 60 });
    expect(await res.json()).toEqual({ minutes: 60 });
  });
});
