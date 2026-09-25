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
  return { app, repo, post: (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) };
}
describe("chores HTTP", () => {
  it("returns durable acceptance and deduplicates retries", async () => {
    const { app, post } = setup();
    const body = { request_key: "same", provider: "codex", prompt: "依頼" };
    expect((await post("/", body)).status).toBe(202);
    expect((await post("/", body)).status).toBe(202);
    const list = await (await app.request("/")).json();
    expect(list.runs).toHaveLength(1);
  });
  it("rejects bad inputs and unknown choices", async () => {
    const { post } = setup();
    expect((await post("/", { request_key: "a", provider: "shell", prompt: "exec" })).status).toBe(400);
    expect((await post("/missing/choice", { action: "continue" })).status).toBe(409);
    expect((await post("/missing/choice", { action: "anything" })).status).toBe(400);
  });
  it("preserves a result until its delivery revision is acknowledged", async () => {
    const { app, post, repo } = setup();
    const { run } = await (await post("/", { request_key: "a", provider: "claude", prompt: "依頼" })).json();
    const done = repo.transition(repo.find(run.id)!, "succeeded", 2)!;
    expect((await (await app.request("/deliveries")).json()).runs).toHaveLength(1);
    await post(`/${run.id}/delivery`, { revision: done.revision, message_id: "123" });
    expect((await (await app.request("/deliveries")).json()).runs).toHaveLength(0);
  });
});
