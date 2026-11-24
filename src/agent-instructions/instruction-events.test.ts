import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { createInstructionEventRelay, type InstructionEvent } from "./instruction-events.js";
import { InstructionService } from "./instruction-service.js";

const input = { agent: "muse" as const, type: "run_task" as const, title: "件名", body: "本文", params: {} };

function setup(listener?: (event: InstructionEvent) => void | Promise<void>) {
  const warnings: Array<Record<string, unknown>> = [];
  const relay = createInstructionEventRelay({ warn: (detail) => { warnings.push(detail); } });
  if (listener) relay.attach(listener);
  const clock = { now: new Date("2026-11-23T00:00:00Z") };
  let seq = 0;
  const service = new InstructionService({
    store: new SqliteAgentInstructionStore(makeTestDb()),
    now: () => clock.now,
    randomSuffix: () => (seq++).toString(16).padStart(6, "0"),
    events: (event) => relay.emit(event),
  });
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { service, relay, warnings, advance };
}

describe("指令の出来事 (CC-INST-INV-08)", () => {
  it("emits registered / acked / finished / requeued with the instruction's agent and title", () => {
    const events: InstructionEvent[] = [];
    const { service, advance } = setup((event) => { events.push(event); });
    const first = service.register(input);
    const second = service.register({ ...input, agent: "dots", title: "dots の件" });
    service.ack(first.id, "muse");
    service.ack(first.id, "muse"); // 重複は出さない
    service.recordResult(first.id, { agent: "muse", status: "done", summary: "済み", detail: { b: 2, a: 1 } });
    service.ack(second.id, "dots");
    advance(31 * 60 * 1000);
    service.sweep();
    expect(events).toEqual([
      { kind: "registered", id: first.id, agent: "muse", type: "run_task", title: "件名", body: "本文", createdAt: "2026-11-23T00:00:00Z" },
      { kind: "registered", id: second.id, agent: "dots", type: "run_task", title: "dots の件", body: "本文", createdAt: "2026-11-23T00:00:00Z" },
      { kind: "acked", id: first.id, agent: "muse", title: "件名", ackedAt: "2026-11-23T00:00:00Z" },
      { kind: "finished", id: first.id, agent: "muse", title: "件名", status: "done", summary: "済み", detail: "{\"a\":1,\"b\":2}", finishedAt: "2026-11-23T00:00:00Z" },
      { kind: "acked", id: second.id, agent: "dots", title: "dots の件", ackedAt: "2026-11-23T00:00:00Z" },
      { kind: "requeued", id: second.id, agent: "dots", title: "dots の件" },
    ]);
  });

  it("a throwing or rejecting listener never fails register / ack / result (best-effort, warn only)", async () => {
    const { service, relay, warnings } = setup(() => { throw new Error("discord down"); });
    const { id } = service.register(input);
    expect(service.get(id)).toMatchObject({ status: "pending" });
    relay.attach(() => Promise.reject(new Error("rate limited")));
    expect(service.ack(id, "muse")).toMatchObject({ kind: "accepted" });
    expect(service.recordResult(id, { agent: "muse", status: "failed", summary: "x" })).toMatchObject({ kind: "accepted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings.map((w) => [w.kind, w.error])).toEqual([
      ["registered", "discord down"], ["acked", "rate limited"], ["finished", "rate limited"],
    ]);
  });

  it("drops events while no listener is attached, and a throwing events dep does not break the service", () => {
    const { service, warnings } = setup();
    expect(service.register(input).status).toBe("pending");
    expect(warnings).toEqual([]);
    const bare = new InstructionService({ store: new SqliteAgentInstructionStore(makeTestDb()), events: () => { throw new Error("boom"); } });
    expect(bare.register(input).status).toBe("pending");
  });
});

describe("InstructionService.history (一覧の口)", () => {
  it("lists newest first, filters by agent and status, and includes body and parsed result detail", () => {
    const { service, advance } = setup();
    const first = service.register({ ...input, params: { a: 1 } });
    advance(1000);
    const second = service.register({ ...input, agent: "dots" });
    service.recordResult(first.id, { agent: "muse", status: "done", summary: "済み", detail: { ok: true } });
    expect(service.history({ limit: 50 }).map((row) => row.id)).toEqual([second.id, first.id]);
    expect(service.history({ agent: "dots", limit: 50 }).map((row) => row.id)).toEqual([second.id]);
    expect(service.history({ status: "done", limit: 50 })).toEqual([expect.objectContaining({
      id: first.id, agent: "muse", body: "本文", params: { a: 1 }, resultSummary: "済み", resultDetail: { ok: true },
    })]);
    expect(service.history({ limit: 1 }).map((row) => row.id)).toEqual([second.id]);
    // 一覧は poll の順序・意味を変えない。
    expect(service.poll("muse", "pending", 10)).toEqual([]);
    expect(service.poll("dots", "pending", 10).map((row) => row.id)).toEqual([second.id]);
  });

  it("delivers to subscribers besides the attached channel and survives their failures (Cc v5 管制カード)", () => {
    const attached: string[] = [];
    const subscribed: string[] = [];
    const { service, relay, warnings } = setup((event) => { attached.push(event.kind); });
    const unsubscribe = relay.subscribe((event) => { subscribed.push(event.kind); });
    relay.subscribe(() => { throw new Error("subscriber broke"); });
    const first = service.register({ ...input, agent: "dots", type: "card_triage" });
    expect(attached).toEqual(["registered"]);
    expect(subscribed).toEqual(["registered"]);
    expect(warnings).toHaveLength(1);
    unsubscribe();
    service.ack(first.id, "dots");
    expect(attached).toEqual(["registered", "acked"]);
    expect(subscribed).toEqual(["registered"]);
  });
});
