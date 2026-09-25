import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { choresRouter } from "../src/api/chores.js";
import { ChoresService } from "../src/chores/service.js";
import { ChoresRepository } from "../src/chores/repository.js";
import { choreCard } from "../src/discord/chores.js";
describe("chore request to result to continuation", () => {
  it("uses one durable run across HTTP acceptance, Discord result and competing choices", async () => {
    const db = new Database(":memory:");
    let sequence = 0;
    const launch = vi.fn(async () => ({ ok: true as const }));
    const service = new ChoresService(new ChoresRepository(db), { now: () => 1, id: () => String(++sequence), cwd: id => `/chores/${id}`,
      isBlocked: () => false, execute: async () => ({ ok: true, output: "保存された結果", error: null }), continue: launch, logError: () => {} });
    const app = new Hono().route("/v1/chores", choresRouter(service));
    const post = (path: string, body: unknown) => app.request(`/v1/chores${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const { run } = await (await post("", { request_key: "discord:1:2", provider: "claude", prompt: "整理して" })).json();
      service.tick();
      // Let the injected CLI promise persist its result, without timers/processes.
      await Promise.resolve(); await Promise.resolve();
      const result = service.repo.find(run.id)!;
      expect(choreCard(result).content).toContain("保存された結果");
      const [first, second] = await Promise.all([post(`/${run.id}/choice`, { action: "continue" }), post(`/${run.id}/choice`, { action: "continue" })]);
      expect(first.status).toBe(200); expect(second.status).toBe(200);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(service.repo.find(run.id)?.status).toBe("continued");
    } finally { await service.stop(); db.close(); }
  });
});
