/**
 * Spawn a new lictor-wrapped agent session in a Windows Terminal tab or
 * window. v0.1 of this module is Windows-only (wt.exe is the launcher
 * dependency); other platforms return a structured error.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { reportError } from "../errors.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("spawner");

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
  /**
   * true when the caller intentionally selected a project cwd. false means
   * Concordia supplied only a launcher/default cwd and the project is still
   * unknown. When omitted, the presence of `cwd` is treated as intentional.
   */
  cwdProvided?: boolean;
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

/** Lictor forwards these values into session registration metadata. */
export const CONCORDIA_SPAWN_ID_ENV = "CONCORDIA_SPAWN_ID";
export const CONCORDIA_SPAWN_CWD_MODE_ENV = "CONCORDIA_SPAWN_CWD_MODE";
export type SpawnCwdMode = "provided" | "omitted";

/**
 * Stamp every Cc-originated interactive spawn with an unforgeable correlation
 * id plus the caller's cwd intent. Values supplied through req.env are
 * overwritten by spawnSession, so external callers cannot impersonate a
 * different pending spawn.
 */
export function buildSpawnIdentityEnv(
  req: Pick<SpawnRequest, "cwd" | "cwdProvided">,
  spawnId: string = randomUUID(),
): Record<string, string> {
  const cwdProvided = req.cwdProvided ?? Boolean(req.cwd?.trim());
  return {
    [CONCORDIA_SPAWN_ID_ENV]: spawnId,
    [CONCORDIA_SPAWN_CWD_MODE_ENV]: cwdProvided ? "provided" : "omitted",
  };
}

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
 * spawn する Lictor へ「接続先 Concordia の住所」を渡すための resolver。 server 起動時に
 * 自分の listen アドレス (cfg.host / cfg.port) を束ねて注入する (setConcordiaAddress)。
 * 未注入なら何も足さない (= Lictor 側の既定 / 既存 env にフォールバック)。
 */
let concordiaAddressResolver: (() => { host: string; port: number }) | null = null;

/** spawn 子 (Lictor) へ注入する Concordia 住所の解決関数を差し替える (server 起動時)。 */
export function setConcordiaAddress(fn: () => { host: string; port: number }): void {
  concordiaAddressResolver = fn;
}

/**
 * Concordia 自身の listen アドレスを spawn 子 (Lictor) 向けの env に変換する (pure)。
 *
 * Lictor は CONCORDIA_HOST / CONCORDIA_PORT で接続先を決めるが、 これを ambient env の
 * 継承に頼ると Concordia の実 listen port (config 既定 11111) と Lictor 既定 (17330) が
 * 食い違って疎通しない。 spawn する Concordia が自分の住所を明示注入することで、 起動された
 * Lictor は必ず spawning Concordia を指す。
 *
 * bind host が wildcard (0.0.0.0 / ::) のときは client から到達できないため loopback へ
 * 寄せる (Lictor は同一ホスト上の sidecar)。
 */
export function buildConcordiaAddressEnv(host: string, port: number): Record<string, string> {
  const out: Record<string, string> = {};
  const h = (host ?? "").trim();
  if (h) out.CONCORDIA_HOST = h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h;
  if (Number.isFinite(port) && port > 0) out.CONCORDIA_PORT = String(port);
  return out;
}

/** resolver が注入済みなら Concordia 住所 env を返す。 未注入 / 失敗時は空 (素通し)。 */
function currentConcordiaAddressEnv(): Record<string, string> {
  if (!concordiaAddressResolver) return {};
  try {
    const { host, port } = concordiaAddressResolver();
    return buildConcordiaAddressEnv(host, port);
  } catch {
    return {};
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
  // コマンドを 1 つの文字列に結合して `& exit 0` を末尾に付ける。
  // これにより lictor が非ゼロ終了してもcmd.exeは 0 で終了し、
  // Windows Terminal が「プロセスはコード 1 で終了しました」メッセージを
  // 表示してタブを残す挙動を防ぐ (closeOnExit: graceful の既定動作を回避)。
  const providerParts = [req.provider, ...(req.args ?? [])];
  out.push("cmd.exe", "/d", "/s", "/c", [...launcher, ...providerParts].join(" ") + " & exit 0");
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

export function resolveCastraDefaultCwd(
  defaultCwd: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.CONCORDIA_CASTRA_CWD?.trim();
  if (explicit) return explicit;
  const fallback = (defaultCwd ?? "").trim();
  if (!fallback) return "";
  const candidate = join(fallback, "Castra");
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Fall back to the configured workspace root.
  }
  return fallback;
}

export function resolveAgentHomeCwd(
  provider: SpawnProvider,
  requested: unknown,
  defaultCwd: string | undefined | null,
): string | undefined {
  if (typeof requested === "string" && requested.trim()) {
    return resolveSpawnCwd(requested, defaultCwd);
  }
  if (provider === "claude" || provider === "codex") {
    return resolveSpawnCwd(undefined, resolveCastraDefaultCwd(defaultCwd));
  }
  return resolveSpawnCwd(undefined, defaultCwd);
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
  // CONCORDIA_HOST / CONCORDIA_PORT は最後に Concordia 自身の listen アドレスで上書きし、
  // ambient env の継承に頼らず spawning Concordia を必ず指すようにする。
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...sanitizeSpawnEnv(req.env),
    ...buildSpawnIdentityEnv(req),
    ...currentConcordiaAddressEnv(),
  };
  // spawn の失敗 (ENOENT / EACCES / EMFILE 等) は非同期の `error` イベントで届く。
  // リスナーが無いと uncaughtException として Concordia 本体を巻き込むため、
  // 同期 throw と合わせて必ず捕捉する (spawn 自体は成功扱いで返っているので
  // ここでは報告のみ — セッション登録が来ないことで spawn 失敗は観測できる)。
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("wt.exe", args, {
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: false,
    });
  } catch (err) {
    const msg = `wt.exe spawn failed: ${(err as Error).message}`;
    log.error({ err }, msg);
    reportError("spawner", msg, { provider: req.provider, cwd: req.cwd });
    return { ok: false, error: msg };
  }
  child.on("error", (err) => {
    const msg = `wt.exe spawn error: ${err.message}`;
    log.error({ err }, msg);
    reportError("spawner", msg, { provider: req.provider, cwd: req.cwd });
  });
  try {
    child.unref();
  } catch {
    // best-effort
  }
  return { ok: true, command: ["wt.exe", ...args], pid: child.pid ?? null };
}
