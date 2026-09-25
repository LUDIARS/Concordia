import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoresRepository } from "./repository.js";
import { ChoresService, type ChorePorts } from "./service.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(overrides: Partial<ChorePorts> = {}) {
  const db = new Database(":memory:"); databases.push(db);
  const repo = new ChoresRepository(db);
  let sequence = 0;
  const ports: ChorePorts = { now: () => 1000, id: () => `id-${++sequence}`, cwd: id => `/chores/${id}`,
    isBlocked: () => false, execute: vi.fn(async () => ({ ok: true, output: "完了", error: null })),
    continue: vi.fn(async () => ({ ok: true as const })), logError: vi.fn(), ...overrides };
  return { repo, ports, service: new ChoresService(repo, ports) };
}
describe("chore acceptance and continuation", () => {
  it("deduplicates replayed messages and rejects changed input under the same key", () => {
    const { service } = setup();
    const a = service.submit("discord:message", "依頼", "claude");
    expect(service.submit("discord:message", "依頼", "claude").id).toBe(a.id);
    expect(() => service.submit("discord:message", "別依頼", "claude")).toThrow();
  });
  it("persists results before exposing choices and only invokes one CLI", async () => {
    const { service, repo, ports } = setup();
    const row = service.submit("a", "依頼", "claude");
    service.tick(); service.tick();
    await service.stop();
    expect(ports.execute).toHaveBeenCalledTimes(1);
    expect(repo.find(row.id)).toMatchObject({ status: "succeeded", output: "完了" });
    expect(repo.undelivered()).toHaveLength(1);
  });
  it("claims Continue before awaiting spawn; repeated clicks cannot create another session", async () => {
    let finish!: (value: { ok: true }) => void;
    const { service, repo, ports } = setup({ continue: vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = resolve; })) });
    const row = service.submit("a", "依頼", "codex");
    repo.transition(row, "succeeded", 1001, { output: "成果" });
    const first = service.choose(row.id, "continue");
    expect((await service.choose(row.id, "continue")).status).toBe("continuing");
    expect((await service.choose(row.id, "ok")).status).toBe("continuing");
    finish({ ok: true });
    expect((await first).status).toBe("continued");
    expect(ports.continue).toHaveBeenCalledTimes(1);
  });
  it("does not replay unknown spawn outcomes", async () => {
    const { service, repo, ports } = setup({ continue: vi.fn(async () => { throw new Error("response lost"); }) });
    const row = service.submit("a", "依頼", "claude");
    repo.transition(row, "succeeded", 1001);
    expect((await service.choose(row.id, "continue")).status).toBe("continuing");
    await service.choose(row.id, "continue");
    expect(ports.continue).toHaveBeenCalledTimes(1);
  });
  it("allows retry only after a definite launch failure", async () => {
    const { service, repo } = setup({ continue: async () => ({ ok: false, error: "launcher missing" }) });
    const row = service.submit("a", "依頼", "claude");
    repo.transition(row, "failed", 1001);
    expect(await service.choose(row.id, "continue")).toMatchObject({ status: "failed", spawn_id: null, error: "launcher missing" });
  });
  it("OK closes without spawning, blocks new submissions at the cost limit", async () => {
    let blocked = false;
    const { service, repo, ports } = setup({ isBlocked: () => blocked });
    const row = service.submit("a", "依頼", "claude");
    repo.transition(row, "succeeded", 1001);
    blocked = true;
    expect(() => service.submit("b", "別依頼", "claude")).toThrow();
    await expect(service.choose(row.id, "continue")).rejects.toThrow();
    expect((await service.choose(row.id, "ok")).status).toBe("acknowledged");
    expect(ports.continue).not.toHaveBeenCalled();
  });
  it("preserves interrupted runs instead of replaying them after restart", () => {
    const { service, repo } = setup();
    const row = service.submit("a", "依頼", "claude");
    expect(repo.claim(1000)?.id).toBe(row.id);
    expect(repo.claim(2000)).toBeNull();
    repo.expireBefore(2000, 999999);
    expect(repo.find(row.id)?.status).toBe("interrupted");
    expect(repo.claim(1000000)).toBeNull();
  });
  it("old delivery receipts cannot hide a newer human choice", async () => {
    const { service, repo } = setup();
    const row = service.submit("a", "依頼", "claude");
    const done = repo.transition(row, "succeeded", 1001)!;
    await service.choose(row.id, "ok");
    repo.delivered(row.id, done.revision, "123");
    expect(repo.undelivered()).toHaveLength(1);
  });
  it("bounds the queue before more processes are started", () => {
    const { service } = setup();
    for (let i = 0; i < 20; i++) service.submit(String(i), "依頼", "claude");
    expect(() => service.submit("overflow", "依頼", "claude")).toThrow(/満杯/);
  });
});
