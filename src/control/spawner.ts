/**
 * Spawn a new lictor-wrapped agent session in a Windows Terminal tab or
 * window. v0.1 of this module is Windows-only (wt.exe is the launcher
 * dependency); other platforms return a structured error.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export type SpawnMode = "tab" | "window";
export type SpawnProvider = "claude" | "codex";

export interface SpawnRequest {
  provider: SpawnProvider;
  args?: string[];
  cwd?: string;
  mode?: SpawnMode;
  title?: string;
  env?: Record<string, string>;
}

export interface SpawnResultOk {
  ok: true;
  command: string[];
  pid: number | null;
}

export interface SpawnResultErr {
  ok: false;
  error: string;
}

export type SpawnResult = SpawnResultOk | SpawnResultErr;

/**
 * Pure: build the wt.exe argv for a spawn request. Useful for unit tests
 * that don't want to actually launch a window.
 *
 *   tab:    wt --window 0   new-tab [--title <t>] [-d <cwd>] cmd /d /s /c lictor <provider> [args]
 *   window: wt --window new new-tab [--title <t>] [-d <cwd>] cmd /d /s /c lictor <provider> [args]
 */
export function buildWtArgs(req: SpawnRequest): string[] {
  const out: string[] = [];
  out.push("--window", req.mode === "window" ? "new" : "0");
  out.push("new-tab");
  if (req.title) out.push("--title", req.title);
  if (req.cwd) out.push("-d", req.cwd);
  out.push("cmd.exe", "/d", "/s", "/c", "lictor", req.provider);
  if (req.args && req.args.length > 0) out.push(...req.args);
  return out;
}

export function validateCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  try {
    if (!existsSync(cwd)) return `cwd does not exist: ${cwd}`;
    if (!statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`;
    return null;
  } catch (err) {
    return `cwd check failed: ${(err as Error).message}`;
  }
}

export function spawnSession(req: SpawnRequest): SpawnResult {
  if (process.platform !== "win32") {
    return { ok: false, error: "spawn currently requires Windows + Windows Terminal (wt.exe)" };
  }
  const cwdErr = validateCwd(req.cwd);
  if (cwdErr) return { ok: false, error: cwdErr };

  const args = buildWtArgs(req);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(req.env ?? {}) };
  const child = spawn("wt.exe", args, {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: false,
  });
  try {
    child.unref();
  } catch {
    // best-effort
  }
  return { ok: true, command: ["wt.exe", ...args], pid: child.pid ?? null };
}
