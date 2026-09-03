import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { clearCodexRateLimitsCache, fetchCodexRateLimits, mapRateLimitsToCostRate } from "./codex-rate-limits.js";

describe("mapRateLimitsToCostRate", () => {
  it("実測レスポンス (weekly が primary / 5h 窓なし) を写像する", () => {
    // codex 0.144.1 の account/rateLimits/read 実測形 (2026-07-13)。
    const raw = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1784497715 },
        secondary: null,
        planType: "pro",
      },
    };
    expect(mapRateLimitsToCostRate(raw)).toEqual({
      used5h: null,
      usedWeekly: 8,
      reset5hAt: null,
      resetWeeklyAt: 1784497715,
      plan: "pro",
    });
  });

  it("5h + weekly の 2 窓は windowDurationMins で振り分ける (position 非依存)", () => {
    const raw = {
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1784000000 },
        secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1784497715 },
        planType: "plus",
      },
    };
    expect(mapRateLimitsToCostRate(raw)).toEqual({
      used5h: 42,
      usedWeekly: 8,
      reset5hAt: 1784000000,
      resetWeeklyAt: 1784497715,
      plan: "plus",
    });
    // 順序が逆でも同じ結果。
    const swapped = {
      rateLimits: {
        primary: raw.rateLimits.secondary,
        secondary: raw.rateLimits.primary,
        planType: "plus",
      },
    };
    expect(mapRateLimitsToCostRate(swapped)).toEqual(mapRateLimitsToCostRate(raw));
  });

  it("窓ゼロ / 形式不明は null (呼び出し元がセッション集計へフォールバック)", () => {
    expect(mapRateLimitsToCostRate(null)).toBeNull();
    expect(mapRateLimitsToCostRate({})).toBeNull();
    expect(mapRateLimitsToCostRate({ rateLimits: { primary: null, secondary: null } })).toBeNull();
    expect(mapRateLimitsToCostRate("nope")).toBeNull();
  });
});

describe("fetchCodexRateLimits: single-flight と直近成功値フォールバック (2026-09-03)", () => {
  beforeEach(() => clearCodexRateLimitsCache());

  /** app-server の初期化応答 + rateLimits 応答を返す最小の spawn 偽装。 */
  function fakeSpawn(result: unknown | Error, rpcError?: unknown): { spawnFn: typeof spawn; calls: () => number } {
    let calls = 0;
    const spawnFn = ((): ChildProcess => {
      calls++;
      const child = new EventEmitter() as ChildProcess & { stdout: EventEmitter; stdin: { write: (s: string) => void }; kill: () => void };
      const stdout = new EventEmitter();
      child.stdout = stdout as never;
      child.kill = (() => true) as ChildProcess["kill"];
      child.stdin = {
        write: (line: string) => {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id === 1) setImmediate(() => stdout.emit("data", Buffer.from(JSON.stringify({ id: 1, result: {} }) + "\n")));
          if (msg.id === 2) {
            setImmediate(() => {
              if (rpcError !== undefined) {
                stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, error: rpcError }) + "\n"));
              } else if (result instanceof Error) child.emit("error", result);
              else stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, result }) + "\n"));
            });
          }
        },
      } as never;
      return child;
    }) as unknown as typeof spawn;
    return { spawnFn, calls: () => calls };
  }

  const OK = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1784497715 }, planType: "pro" } };

  it("同時呼び出しは app-server を 1 回しか起動しない", async () => {
    const fake = fakeSpawn(OK);
    const [a, b, c] = await Promise.all([
      fetchCodexRateLimits({ spawnFn: fake.spawnFn }),
      fetchCodexRateLimits({ spawnFn: fake.spawnFn }),
      fetchCodexRateLimits({ spawnFn: fake.spawnFn }),
    ]);
    expect(fake.calls()).toBe(1);
    expect(a?.usedWeekly).toBe(12);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("取得失敗時は 30 分以内の直近成功値を返す (force でも)", async () => {
    const ok = fakeSpawn(OK);
    const first = await fetchCodexRateLimits({ spawnFn: ok.spawnFn });
    expect(first?.usedWeekly).toBe(12);
    const warn = vi.fn();
    const broken = fakeSpawn(new Error("app-server down"));
    const second = await fetchCodexRateLimits({ spawnFn: broken.spawnFn, force: true, log: { warn } });
    expect(second).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("serving last good value"));
  });

  it("RPC エラー時は直近成功値やエラー詳細を公開しない", async () => {
    const first = await fetchCodexRateLimits({ spawnFn: fakeSpawn(OK).spawnFn });
    expect(first?.usedWeekly).toBe(12);
    const warn = vi.fn();
    const rejected = fakeSpawn(null, { message: "private account detail" });

    expect(await fetchCodexRateLimits({ spawnFn: rejected.spawnFn, force: true, log: { warn } })).toBeNull();
    expect(warn).toHaveBeenCalledWith("codex rate-limits read returned an error response");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("private account detail"));
  });

  it("30 分を超えた成功値にはフォールバックしない", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const first = await fetchCodexRateLimits({ spawnFn: fakeSpawn(OK).spawnFn });
      expect(first?.usedWeekly).toBe(12);
      now.mockReturnValue(1_000 + 30 * 60_000);

      const broken = fakeSpawn(new Error("app-server down"));
      expect(await fetchCodexRateLimits({ spawnFn: broken.spawnFn, force: true })).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});
