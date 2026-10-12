/** @implements spec/setup/harness-supervisor.md — bounded wait for the Cc gate, distinguishing "slow" from "down" */
import { request } from "node:http";

export interface GateResponse { status: number; body: unknown }

/**
 * - `online`: the gate answered (any status; 5xx is treated as unavailable by the caller).
 * - `slow`: /health answered but the gate did not answer within the hard limit.
 * - `offline`: neither the gate nor /health answered.
 */
export type GateOutcome = { kind: "online"; response: GateResponse } | { kind: "slow" } | { kind: "offline" };

export interface GateWaitLimits {
  /** After this long without an answer, probe /health to tell "slow" from "down". */
  softMs: number;
  /** Absolute cap per hook call while Cc is alive; never wait unbounded per Bash call. */
  hardMs: number;
  healthMs: number;
}

// Observed gate latency on 2026-10-12: p50 2.5s / p90 5.5s / p99 11.2s, /health 5-17ms.
export const DEFAULT_GATE_WAIT: GateWaitLimits = { softMs: 2000, hardMs: 15000, healthMs: 1000 };

/** Pure classification of what the wait produced. */
export function classifyGateWait(response: GateResponse | null, healthy: boolean): GateOutcome {
  if (response) return { kind: "online", response };
  return healthy ? { kind: "slow" } : { kind: "offline" };
}

function call(port: number, path: string, method: string, payload: unknown, timeoutMs: number): {
  result: Promise<GateResponse | null>; abort: () => void;
} {
  let abort = (): void => {};
  const result = new Promise<GateResponse | null>((done) => {
    let settled = false;
    const finish = (value: GateResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const req = request({ host: "127.0.0.1", port, path, method, agent: false,
      headers: { "content-type": "application/json" } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 1_000_000) { finish({ status: 502, body: null }); req.destroy(); }
      });
      response.on("error", () => finish(null));
      response.on("end", () => {
        try { finish({ status: response.statusCode ?? 502, body: JSON.parse(text) }); }
        catch { finish({ status: response.statusCode ?? 502, body: null }); }
      });
    });
    const timer = setTimeout(() => { finish(null); req.destroy(); }, timeoutMs);
    abort = () => { finish(null); req.destroy(); };
    req.on("error", () => finish(null));
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
  return { result, abort };
}

/** Ask the Cc gate; keep waiting past `softMs` only while /health proves Cc is alive. */
export async function queryGate(port: number, payload: unknown, limits: GateWaitLimits = DEFAULT_GATE_WAIT): Promise<GateOutcome> {
  const gate = call(port, "/v1/harness/gate", "POST", payload, limits.hardMs);
  let softTimer: NodeJS.Timeout | undefined;
  const soft = new Promise<"soft">((done) => { softTimer = setTimeout(() => done("soft"), limits.softMs); });
  const first = await Promise.race([gate.result, soft]);
  clearTimeout(softTimer);
  if (first !== "soft") return classifyGateWait(first, false);
  const health = await call(port, "/health", "GET", undefined, limits.healthMs).result;
  const healthy = health !== null && health.status === 200;
  if (!healthy) gate.abort();
  return classifyGateWait(await gate.result, healthy);
}
