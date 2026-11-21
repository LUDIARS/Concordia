import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAgyUsageCache, fetchAgyUsage, resolveAgyBinary } from "./agy-usage-fetch.js";

const OUTPUT = "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-28T08:55:11Z\nGemini Models\tFive Hour Limit Remaining\t92%\t2026-11-21T13:55:11Z\n";

/** stdout を書いて終了コードで閉じる偽の子プロセス。 */
function fakeSpawn(behavior: { stdout?: string; code?: number | null; error?: Error }) {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  const fn = ((binary: string, args: readonly string[]) => {
    calls.push({ binary, args });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      if (behavior.error) { child.emit("error", behavior.error); return; }
      if (behavior.stdout) child.stdout.write(behavior.stdout);
      child.stdout.end();
      if (behavior.code !== null) child.emit("close", behavior.code ?? 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { fn, calls };
}

afterEach(() => clearAgyUsageCache());

describe("resolveAgyBinary", () => {
  it("prefers LICTOR_AGY_BIN, then the installer default, then PATH", () => {
    expect(resolveAgyBinary({ LICTOR_AGY_BIN: "C:/x/agy.exe", LOCALAPPDATA: "C:/L" }, () => true)).toBe("C:/x/agy.exe");
    expect(resolveAgyBinary({ LOCALAPPDATA: "C:/L" }, () => true)).toMatch(/agy[\\/]bin[\\/]agy\.exe$/);
    expect(resolveAgyBinary({ LOCALAPPDATA: "C:/L" }, () => false)).toBe("agy");
    expect(resolveAgyBinary({}, () => true)).toBe("agy");
  });
});

describe("fetchAgyUsage (Gemini usage C-5)", () => {
  it("runs `-p /usage` without a shell and parses the output", async () => {
    const { fn, calls } = fakeSpawn({ stdout: OUTPUT, code: 0 });
    const usage = await fetchAgyUsage({ spawnFn: fn, binary: "agy", force: true });
    expect(calls).toEqual([{ binary: "agy", args: ["-p", "/usage"] }]);
    expect(usage?.weekly?.usedPct).toBe(2);
    expect(usage?.fiveHour?.usedPct).toBe(8);
  });

  it("caches within the TTL and shares one in-flight fetch", async () => {
    const { fn, calls } = fakeSpawn({ stdout: OUTPUT, code: 0 });
    const [a, b] = await Promise.all([fetchAgyUsage({ spawnFn: fn, binary: "agy" }), fetchAgyUsage({ spawnFn: fn, binary: "agy" })]);
    expect(a).toBe(b);
    await fetchAgyUsage({ spawnFn: fn, binary: "agy" });
    expect(calls).toHaveLength(1);
  });

  it("serves the last good value on a transient failure but not for an API-key connection (exit 2)", async () => {
    let now = 1_000_000;
    await fetchAgyUsage({ spawnFn: fakeSpawn({ stdout: OUTPUT, code: 0 }).fn, binary: "agy", force: true, now: () => now });
    now += 60_000;
    const warn = vi.fn();
    const stale = await fetchAgyUsage({ spawnFn: fakeSpawn({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }).fn, binary: "agy", force: true, now: () => now, log: { warn } });
    expect(stale?.weekly?.usedPct).toBe(2);
    expect(warn).toHaveBeenCalled();
    expect(await fetchAgyUsage({ spawnFn: fakeSpawn({ code: 2 }).fn, binary: "agy", force: true, now: () => now })).toBeNull();
  });

  it("returns null when the output has no quota rows", async () => {
    expect(await fetchAgyUsage({ spawnFn: fakeSpawn({ stdout: "unexpected", code: 0 }).fn, binary: "agy", force: true })).toBeNull();
  });

  it("times out instead of waiting forever", async () => {
    const usage = await fetchAgyUsage({ spawnFn: fakeSpawn({ code: null }).fn, binary: "agy", force: true, timeoutMs: 20 });
    expect(usage).toBeNull();
  });
});
