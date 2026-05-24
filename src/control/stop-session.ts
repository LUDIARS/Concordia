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

import { spawnSync } from "node:child_process";

export interface StopOk { ok: true; method: "taskkill" | "signal" }
export interface StopErr { ok: false; error: string }
export type StopResult = StopOk | StopErr;

export function stopSessionByLictorPid(pid: number): StopResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: `invalid pid: ${pid}` };
  }
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (r.status === 0) return { ok: true, method: "taskkill" };
    const stderr = (r.stderr ?? "").trim();
    const stdout = (r.stdout ?? "").trim();
    return { ok: false, error: stderr || stdout || `taskkill exit ${r.status}` };
  }
  try {
    process.kill(-pid, "SIGTERM");
    return { ok: true, method: "signal" };
  } catch (err) {
    // EPERM / ESRCH (process gone) — try direct PID as a fallback.
    try {
      process.kill(pid, "SIGTERM");
      return { ok: true, method: "signal" };
    } catch (err2) {
      return { ok: false, error: (err2 as Error).message };
    }
  }
}
