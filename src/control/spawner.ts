/**
 * Spawn a new lictor-wrapped agent session in a Windows Terminal tab or
 * window. v0.1 of this module is Windows-only (wt.exe is the launcher
 * dependency); other platforms return a structured error.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export type SpawnMode = "tab" | "window";
/**
 * 起動可能な provider. Lictor の PROVIDERS に対応する名前と 1:1 で揃える.
 * 新 provider 追加時はここと Lictor の `src/provider.ts`、 API 側の validation
 * (このファイル中の SPAWN_PROVIDERS、 spawn / admin/spawn-session ハンドラ) を
 * 同時に更新する.
 */
export type SpawnProvider = "claude" | "codex" | "gemini" | "gemma4-12";

/** Runtime 用 provider allow-list. API 側の validation で参照する. */
export const SPAWN_PROVIDERS: readonly SpawnProvider[] = ["claude", "codex", "gemini", "gemma4-12"];

export function isSpawnProvider(v: unknown): v is SpawnProvider {
  return typeof v === "string" && (SPAWN_PROVIDERS as readonly string[]).includes(v);
}

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
 * Lictor の起動コマンド (launcher) を解決する関数。 既定は PATH 上の `lictor`。
 * server 起動時に AdminState 由来の resolver を注入すると、 dev/prod モードや
 * 明示パスを spawn のたびに反映できる (setLictorLauncherResolver)。
 */
let lictorLauncherResolver: () => string[] = () => ["lictor"];

/** Lictor launcher の解決関数を差し替える (server 起動時に AdminState を束ねて注入)。 */
export function setLictorLauncherResolver(fn: () => string[]): void {
  lictorLauncherResolver = fn;
}

/** 現在の launcher トークン列 (空配列は無効とみなし bare `lictor` にフォールバック)。 */
function currentLictorLauncher(): string[] {
  try {
    const l = lictorLauncherResolver();
    return Array.isArray(l) && l.length > 0 ? l : ["lictor"];
  } catch {
    return ["lictor"];
  }
}

/**
 * Pure: build the wt.exe argv for a spawn request. Useful for unit tests
 * that don't want to actually launch a window.
 *
 *   tab:    wt --window 0   new-tab [--title <t>] [-d <cwd>] cmd /d /s /c <launcher...> <provider> [args]
 *   window: wt --window new new-tab [--title <t>] [-d <cwd>] cmd /d /s /c <launcher...> <provider> [args]
 *
 * `launcher` は Lictor 起動トークン (既定 ["lictor"])。 テストは明示指定できる。
 */
export function buildWtArgs(req: SpawnRequest, launcher: string[] = ["lictor"]): string[] {
  const out: string[] = [];
  out.push("--window", req.mode === "window" ? "new" : "0");
  out.push("new-tab");
  if (req.title) out.push("--title", req.title);
  if (req.cwd) out.push("-d", req.cwd);
  out.push("cmd.exe", "/d", "/s", "/c", ...launcher, req.provider);
  if (req.args && req.args.length > 0) out.push(...req.args);
  return out;
}

/**
 * Pick the effective cwd for a spawn request:
 *
 *   1. body.cwd if the caller provided a non-empty string
 *   2. fallback to `defaultCwd` if it exists on disk
 *   3. undefined → spawner uses Concordia's own process.cwd()
 *
 * The "exists on disk" check on the fallback guards against env-var
 * typos that would otherwise propagate into wt.exe and fail there.
 */
export function resolveSpawnCwd(
  requested: unknown,
  defaultCwd: string | undefined | null,
): string | undefined {
  // 未展開の `${var}` を含む値は無効扱い (defaultCwd へフォールバック)。 テンプレの
  // default_cwd を展開し忘れた場合に "${target_repo}" がそのまま wt -d に渡って
  // spawn が落ちるのを防ぐ防御 (本来の展開は呼び出し側 substituteVars が行う)。
  if (typeof requested === "string" && requested.trim() && !requested.includes("${")) {
    return requested.trim();
  }
  const fallback = (defaultCwd ?? "").trim();
  if (!fallback) return undefined;
  if (!existsSync(fallback)) return undefined;
  try {
    if (!statSync(fallback).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return fallback;
}

/**
 * spawn child に渡してよい env key の prefix allowlist。
 * Concordia が自前で設定する LICTOR_* (例 LICTOR_LOCAL_MODEL) / CONCORDIA_* のみ。
 * これ以外 (NODE_OPTIONS / LD_PRELOAD / PATH 等) は一切通さない。
 */
const SPAWN_ENV_ALLOW_PREFIXES = ["LICTOR_", "CONCORDIA_"] as const;

/** allowlist prefix の key だけを残す (CWE-78 env 注入対策、 pure)。 */
export function sanitizeSpawnEnv(
  reqEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!reqEnv) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(reqEnv)) {
    if (typeof v !== "string") continue;
    if (SPAWN_ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
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

  const args = buildWtArgs(req, currentLictorLauncher());
  // CWE-78 対策: 外部入力 env を子プロセスへ素通ししない。 公開 spawn API は env を
  // 受け取らない (HTTP ハンドラ側で破棄) ようにしたうえで、 ここでも防御的に
  // Concordia 自身が設定する allowlist key (LICTOR_* / CONCORDIA_*) のみ通す。
  // NODE_OPTIONS / LD_PRELOAD / PATH 等の loader 系を注入されると lictor 経由 Node の
  // 任意コード実行に至るため、 prefix allowlist でそれらを構造的に排除する。
  const env: NodeJS.ProcessEnv = { ...process.env, ...sanitizeSpawnEnv(req.env) };
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
