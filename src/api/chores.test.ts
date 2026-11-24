import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { choresRouter } from "./chores.js";
import { ChoresRepository } from "../chores/repository.js";
import { ChoresService } from "../chores/service.js";
const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
function setup() {
  const db = new Database(":memory:"); dbs.push(db);
  const repo = new ChoresRepository(db);
  let id = 0;
  const service = new ChoresService(repo, { now: () => 1, id: () => String(++id), cwd: id => `/chores/${id}`,
    isBlocked: () => false, execute: async () => ({ ok: true, output: "done", error: null }),
    continue: async () => ({ ok: true }), logError: () => {} });
  const app = choresRouter(service);
  return { app, repo, service, post: (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) };
}
describe("chores HTTP", () => {
  it("retires new intake with 410 and points to the desk (Cc v5)", async () => {
    const { app, post } = setup();
    const response = await post("/", { request_key: "same", provider: "codex", prompt: "依頼" });
    expect(response.status).toBe(410);
    expect((await response.json()).error).toBe("chores_retired_use_desk");
    const list = await (await app.request("/")).json();
    expect(list.runs).toHaveLength(0);
  });
  it("rejects unknown choices", async () => {
    const { post } = setup();
    expect((await post("/missing/choice", { action: "continue" })).status).toBe(409);
    expect((await post("/missing/choice", { action: "anything" })).status).toBe(400);
  });
  it("preserves a result until its delivery revision is acknowledged", async () => {
    const { app, post, repo, service } = setup();
    const run = service.submit("a", "依頼", "claude");
    const done = repo.transition(repo.find(run.id)!, "succeeded", 2)!;
    expect((await (await app.request("/deliveries")).json()).runs).toHaveLength(1);
    await post(`/${run.id}/delivery`, { revision: done.revision, message_id: "123" });
    expect((await (await app.request("/deliveries")).json()).runs).toHaveLength(0);
  });
});
