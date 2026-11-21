import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { InstructionService } from "./instruction-service.js";

function setup(start = "2026-11-21T00:00:00Z") {
  const db = makeTestDb();
  const clock = { now: new Date(start) };
  let seq = 0;
  const service = new InstructionService({
    store: new SqliteAgentInstructionStore(db),
    now: () => clock.now,
    randomSuffix: () => (seq++).toString(16).padStart(6, "0"),
  });
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { db, service, advance };
}

const input = { agent: "muse" as const, type: "run_task" as const, title: "t", body: "b", params: { a: 1 } };

describe("InstructionService (spec/feature/agent-instructions-bridge.md)", () => {
  it("registers, polls oldest first, acks, reports and stops redelivering", () => {
    const { service, advance } = setup();
    const first = service.register(input);
    advance(1000);
    const second = service.register({ ...input, title: "second" });
    expect(first).toEqual({ id: "inst:muse:20261121T000000Z:000000", status: "pending", createdAt: "2026-11-21T00:00:00Z" });
    expect(service.poll("muse", "pending", 10).map((item) => item.id)).toEqual([first.id, second.id]);
    expect(service.poll("muse", "pending", 1)[0]).toEqual({ id: first.id, type: "run_task", title: "t", body: "b", params: { a: 1 }, createdAt: first.createdAt });

    expect(service.ack(first.id, "muse")).toMatchObject({ kind: "accepted", status: "acked" });
    expect(service.ack(first.id, "muse")).toMatchObject({ kind: "duplicate" });
    expect(service.recordResult(first.id, { agent: "muse", status: "done", summary: "ok", detail: { x: 1 } })).toMatchObject({ kind: "accepted", status: "done" });
    expect(service.poll("muse", "pending", 10).map((item) => item.id)).toEqual([second.id]);
    expect(service.get(first.id)).toMatchObject({ status: "done", resultSummary: "ok", finishedAt: expect.any(String) });
  });

  it("CC-INST-INV-04: identical result is duplicate, a different one conflicts, ack after finish conflicts", () => {
    const { service } = setup();
    const { id } = service.register(input);
    service.recordResult(id, { agent: "muse", status: "done", summary: "ok", detail: { b: 2, a: 1 } });
    expect(service.recordResult(id, { agent: "muse", status: "done", summary: "ok", detail: { a: 1, b: 2 } })).toMatchObject({ kind: "duplicate" });
    expect(service.recordResult(id, { agent: "muse", status: "failed", summary: "ok", detail: { a: 1, b: 2 } })).toEqual({ kind: "conflict", status: "done" });
    expect(service.ack(id, "muse")).toEqual({ kind: "conflict", status: "done" });
  });

  it("accepts a result straight from pending and records acked_at too", () => {
    const { service } = setup();
    const { id } = service.register(input);
    expect(service.recordResult(id, { agent: "muse", status: "failed", summary: "skipped ack" })).toMatchObject({ kind: "accepted" });
    expect(service.get(id)).toMatchObject({ status: "failed", ackedAt: "2026-11-21T00:00:00Z", finishedAt: "2026-11-21T00:00:00Z" });
  });

  it("returns not_found for unknown ids", () => {
    const { service } = setup();
    expect(service.ack("inst:muse:20261121T000000Z:ffffff", "muse")).toEqual({ kind: "not_found" });
    expect(service.recordResult("inst:muse:20261121T000000Z:ffffff", { agent: "muse", status: "done", summary: "x" })).toEqual({ kind: "not_found" });
    expect(service.get("inst:muse:20261121T000000Z:ffffff")).toBeNull();
  });

  it("CC-INST-INV-05: an ack without result for 30 minutes goes back to pending", () => {
    const { service, advance } = setup();
    const { id } = service.register(input);
    service.ack(id, "muse");
    advance(29 * 60 * 1000);
    expect(service.poll("muse", "pending", 10)).toEqual([]);
    advance(60 * 1000 + 1000);
    expect(service.poll("muse", "pending", 10).map((item) => item.id)).toEqual([id]);
    expect(service.get(id)).toMatchObject({ status: "pending", ackedAt: null });
    expect(service.ack(id, "muse")).toMatchObject({ kind: "accepted" });
  });

  it("sweep requeues stale acks and purges finished instructions after 90 days", () => {
    const { service, advance } = setup();
    const stale = service.register(input);
    const finished = service.register({ ...input, title: "done" });
    service.ack(stale.id, "muse");
    service.recordResult(finished.id, { agent: "muse", status: "done", summary: "ok" });
    advance(31 * 60 * 1000);
    expect(service.sweep()).toEqual({ requeued: 1, purged: 0 });
    advance(90 * 86_400_000);
    expect(service.sweep()).toEqual({ requeued: 0, purged: 1 });
    expect(service.get(finished.id)).toBeNull();
    expect(service.get(stale.id)).toMatchObject({ status: "pending" });
  });

  it("redraws the id suffix on collision", () => {
    const db = makeTestDb();
    const suffixes = ["aaaaaa", "aaaaaa", "bbbbbb"];
    const service = new InstructionService({
      store: new SqliteAgentInstructionStore(db),
      now: () => new Date("2026-11-21T00:00:00Z"),
      randomSuffix: () => suffixes.shift() ?? "cccccc",
    });
    expect(service.register(input).id).toBe("inst:muse:20261121T000000Z:aaaaaa");
    expect(service.register(input).id).toBe("inst:muse:20261121T000000Z:bbbbbb");
  });
});
