import { describe, expect, it } from "vitest";
import { createCostLeaseWatchTick, type CostLeaseWatchDeps } from "./cost.js";
import type { WorkerLease } from "../shared/worker-lease.js";

const LEASE: WorkerLease = {
  kind: "worker",
  role: "cost-sampler",
  owner: "worker-1",
  pid: 123,
  ts: 1_000,
  expires_at: 91_000,
  fencing_token: 1,
};

function makeDeps(overrides: Partial<CostLeaseWatchDeps> = {}): {
  deps: CostLeaseWatchDeps;
  calls: { started: number; stopped: number; reported: Array<WorkerLease | null>; warns: string[] };
  setRunning: (v: boolean) => void;
  setLease: (v: WorkerLease | null) => void;
} {
  let running = false;
  let lease: WorkerLease | null = null;
  const calls = { started: 0, stopped: 0, reported: [] as Array<WorkerLease | null>, warns: [] as string[] };
  const deps: CostLeaseWatchDeps = {
    mode: "embedded",
    runtime: {
      isRunning: () => running,
      start: () => { calls.started++; running = true; },
      stop: () => { calls.stopped++; running = false; },
    },
    readLease: () => lease,
    log: { info: () => {}, warn: (m) => calls.warns.push(m) },
    reportWorkerDown: (l) => calls.reported.push(l),
    ...overrides,
  };
  return { deps, calls, setRunning: (v) => { running = v; }, setLease: (v) => { lease = v; } };
}

describe("createCostLeaseWatchTick", () => {
  it("embedded: lease が生きたら embedded サンプラを止める (既存挙動)", () => {
    const { deps, calls, setRunning, setLease } = makeDeps();
    const tick = createCostLeaseWatchTick(deps);
    setRunning(true);
    setLease(LEASE);
    tick();
    expect(calls.stopped).toBe(1);
    expect(calls.reported).toHaveLength(0);
  });

  it("embedded: lease 失効で embedded サンプラを再開する", () => {
    const { deps, calls, setLease } = makeDeps();
    const tick = createCostLeaseWatchTick(deps);
    setLease(LEASE);
    tick(); // lease 生存 (not running なので何もしない)
    setLease(null);
    tick();
    expect(calls.started).toBe(1);
    // 再開済みなら次 tick では二重 start しない。
    tick();
    expect(calls.started).toBe(1);
  });

  it("worker: lease 失効で 1 回だけ reportWorkerDown する", () => {
    const { deps, calls, setLease } = makeDeps({ mode: "worker" });
    const tick = createCostLeaseWatchTick(deps);
    setLease(LEASE);
    tick();
    setLease(null);
    tick();
    tick();
    tick();
    expect(calls.reported).toEqual([LEASE]);
    expect(calls.started).toBe(0); // worker モードでは embedded を起動しない
  });

  it("worker: lease が復活したら報告フラグがリセットされ、 再失効で再報告する", () => {
    const { deps, calls, setLease } = makeDeps({ mode: "worker" });
    const tick = createCostLeaseWatchTick(deps);
    setLease(null);
    tick(); // boot 時点で失効 → lastLease 不明のまま報告
    expect(calls.reported).toEqual([null]);
    setLease(LEASE);
    tick();
    setLease(null);
    tick();
    expect(calls.reported).toEqual([null, LEASE]);
  });

  it("off: 何もしない", () => {
    const { deps, calls, setLease } = makeDeps({ mode: "off" });
    const tick = createCostLeaseWatchTick(deps);
    setLease(null);
    tick();
    setLease(LEASE);
    tick();
    expect(calls.started).toBe(0);
    expect(calls.stopped).toBe(0);
    expect(calls.reported).toHaveLength(0);
  });

  it("workflow.cost が無効なら sampler を止め、 lease 失効でも再開しない", () => {
    const { deps, calls, setRunning, setLease } = makeDeps({
      isWorkflowEnabled: () => false,
    });
    const tick = createCostLeaseWatchTick(deps);
    setRunning(true);
    setLease(null);

    tick();

    expect(calls.stopped).toBe(1);
    expect(calls.started).toBe(0);
    expect(calls.reported).toHaveLength(0);
  });

  it("workflow.cost 再有効化の最初の tick では lease 再取得待ちを worker down と誤報しない", () => {
    let enabled = false;
    const { deps, calls, setLease } = makeDeps({
      mode: "worker",
      isWorkflowEnabled: () => enabled,
    });
    const tick = createCostLeaseWatchTick(deps);

    tick();
    enabled = true;
    tick();
    expect(calls.reported).toHaveLength(0);

    // 猶予後も lease が無ければ通常どおり停止を報告する。
    tick();
    expect(calls.reported).toEqual([null]);

    // worker が lease を取り直せば次の失効監視へ戻る。
    setLease(LEASE);
    tick();
    expect(calls.reported).toEqual([null]);
  });
});
