import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTaskQueueLogger } from "./background-task-queue.js";

function collectLogger(): BackgroundTaskQueueLogger & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  // drain の microtask 連鎖を流し切る。
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("BackgroundTaskQueue maxDepth", () => {
  it("溢れたら droppable を古い順に捨てる (実行中タスクは数えない)", async () => {
    const log = collectLogger();
    const q = new BackgroundTaskQueue({ name: "t", log, maxDepth: 2, verbose: false });
    const gate = deferred();
    const ran: string[] = [];

    q.enqueue("a", async () => { ran.push("a"); await gate.promise; });
    q.enqueue("b", () => { ran.push("b"); }, { droppable: true });
    q.enqueue("c", () => { ran.push("c"); }, { droppable: true });
    // depth=2 (=maxDepth) → 次の enqueue で最古の droppable "b" が落ちる
    q.enqueue("d", () => { ran.push("d"); }, { droppable: true });

    gate.resolve();
    await settle();

    expect(ran).toEqual(["a", "c", "d"]);
    expect(q.stats().dropped).toBe(1);
    expect(log.warns.some((w) => w.includes("overflow") && w.includes("#2 b"))).toBe(true);
  });

  it("droppable が無ければ捨てずに積む (重要タスク保護)", async () => {
    const log = collectLogger();
    const q = new BackgroundTaskQueue({ name: "t", log, maxDepth: 1, verbose: false });
    const gate = deferred();
    const ran: string[] = [];

    q.enqueue("a", async () => { await gate.promise; });
    q.enqueue("b", () => { ran.push("b"); });
    q.enqueue("c", () => { ran.push("c"); });

    gate.resolve();
    await settle();

    expect(ran).toEqual(["b", "c"]);
    expect(q.stats().dropped).toBe(0);
    expect(log.warns.some((w) => w.includes("no droppable"))).toBe(true);
  });

  it("maxDepth 未指定なら従来どおり無制限", async () => {
    const log = collectLogger();
    const q = new BackgroundTaskQueue({ name: "t", log, verbose: false });
    const gate = deferred();
    q.enqueue("a", async () => { await gate.promise; });
    for (let i = 0; i < 50; i++) q.enqueue(`x${i}`, () => {}, { droppable: true });
    gate.resolve();
    await settle();
    expect(q.stats().dropped).toBe(0);
    expect(q.stats().processed).toBe(51);
  });
});

describe("BackgroundTaskQueue verbose", () => {
  it("verbose=false では per-task ログを出さない (失敗は warn する)", async () => {
    const log = collectLogger();
    const q = new BackgroundTaskQueue({ name: "t", log, verbose: false });
    q.enqueue("ok", () => {});
    q.enqueue("bad", () => { throw new Error("boom"); });
    await settle();

    expect(log.infos.filter((m) => m.includes("enqueued") || m.includes("start") || m.includes("done"))).toEqual([]);
    expect(log.warns.some((w) => w.includes("failed") && w.includes("bad") && w.includes("boom"))).toBe(true);
  });

  it("既定 (verbose) では従来どおり enqueued/start/done を出す", async () => {
    const log = collectLogger();
    const q = new BackgroundTaskQueue({ name: "t", log });
    q.enqueue("ok", () => {});
    await settle();
    expect(log.infos.some((m) => m.includes("enqueued #1 ok"))).toBe(true);
    expect(log.infos.some((m) => m.includes("done #1 ok"))).toBe(true);
  });
});
