/**
 * Kill a lictor-wrapped session by its wrapper PID.
 *
 * On Windows we shell out to `taskkill /F /T /PID <pid>` because /T walks
 * the process tree (lictor → cmd.exe → claude.exe → claude's tool
 * subprocesses) and a plain `process.kill` only signals the immediate PID.
 * On POSIX we send SIGTERM to the negative PID (i.e. the process group),
 * which propagates to claude and any tools claude spawned. Lictor's own
 * `child.onExit` handler does the orderly cleanup (sidecar close, title
 * reset, Concordia unregister) so we don't have to.
 *
 * Returns `{ok:false, error}` when the kill cannot be issued (process
 * already gone, permission denied). The caller decides whether to still
 * mark the session ended on a soft failure.
 */

import { spawn } from "node:child_process";

const TASKKILL_TIMEOUT_MS = 30_000;

export interface StopOk { ok: true; method: "taskkill" | "signal" }
export interface StopErr { ok: false; error: string }
export type StopResult = StopOk | StopErr;

/** pid が生存しているか (signal 0)。 EPERM は「存在するが権限なし」= 生存扱い。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 非同期で kill を発行する。 Windows の taskkill はプロセスツリーが大きい /
 * ハングしていると数秒かかることがあり、 旧実装の spawnSync は HTTP ハンドラや
 * reaper tick の上でイベントループごと停止させていた (2026-07-16 障害調査)。
 * 返す Promise は reject しない (エラーは StopErr で表現)。
 */
export function stopSessionByLictorPid(pid: number): Promise<StopResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, error: `invalid pid: ${pid}` });
  }
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (result: StopResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        done({ ok: false, error: `taskkill timeout after ${TASKKILL_TIMEOUT_MS}ms` });
      }, TASKKILL_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.on("error", (err) => done({ ok: false, error: err.message }));
      child.on("close", (code) => {
        if (code === 0) done({ ok: true, method: "taskkill" });
        else done({ ok: false, error: stderr.trim() || stdout.trim() || `taskkill exit ${code}` });
      });
    });
  }
  try {
    process.kill(-pid, "SIGTERM");
    return Promise.resolve({ ok: true, method: "signal" });
  } catch {
    // EPERM / ESRCH (process gone) — try direct PID as a fallback.
    try {
      process.kill(pid, "SIGTERM");
      return Promise.resolve({ ok: true, method: "signal" });
    } catch (err2) {
      return Promise.resolve({ ok: false, error: (err2 as Error).message });
    }
  }
}
