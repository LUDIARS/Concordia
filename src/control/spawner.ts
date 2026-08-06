/**
 * Spawn a new lictor-wrapped agent session in a Windows Terminal tab or
 * window. v0.1 of this module is Windows-only (wt.exe is the launcher
 * dependency); other platforms return a structured error.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

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
export type SpawnProvider = "claude" | "codex" | "codex-sdk" | "gemini" | "gemma4-12";

/** Runtime 用 provider allow-list. API 側の validation で参照する. */
export const SPAWN_PROVIDERS: readonly SpawnProvider[] = ["claude", "codex", "codex-sdk", "gemini", "gemma4-12"];

/**
 * codex-sdk (Satelles) はウィンドウ / PTY / Lictor を使わないヘッドレス spawn。
 * wt.exe 経路とは別に、 satelles CLI を detached child として直接起動する。
 */
export const HEADLESS_SPAWN_PROVIDERS: ReadonlySet<SpawnProvider> = new Set(["codex-sdk"]);

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
  /** pending spawn と SessionStart を cwd ではなく一意に結ぶ相関 ID。 */
  spawnId?: string;
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
 * Satelles (codex-sdk headless runner) の起動コマンド resolver。 既定は PATH 上の
 * `satelles`。 `CONCORDIA_SATELLES_LAUNCHER` で明示パスに差し替え可能
 * (dev checkout の bin/satelles.mjs を node で指す等、 セミコロン区切りトークン)。
 */
export function currentSatellesLauncher(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CONCORDIA_SATELLES_LAUNCHER?.trim();
  if (!raw) return ["satelles"];
  const tokens = raw.split(";").map((t) => t.trim()).filter(Boolean);
  return tokens.length > 0 ? tokens : ["satelles"];
}

/**
 * spawn する Lictor へ「接続先 Concordia の住所」を渡すための resolver。 server 起動時に
 * 自分の listen アドレス (cfg.host / cfg.port) を束ねて注入する (setConcordiaAddress)。
 * 未注入なら何も足さない (= Lictor 側の既定 / 既存 env にフォールバック)。
 */
let concordiaAddressResolver: (() => { host: string; port: number }) | null = null;
let workspaceRootsResolver: (() => string[]) | null = null;

/** spawn 子 (Lictor) へ注入する Concordia 住所の解決関数を差し替える (server 起動時)。 */
export function setConcordiaAddress(fn: () => { host: string; port: number }): void {
  concordiaAddressResolver = fn;
}

/**
 * workspace/Castra root 群を runtime 設定から解決する resolver を差し替える。
 *
 * 以前は「Session cwd として禁止するリスト」を組み立てるためだけに使っていたが、
 * cwd=workspace root 自体は禁止しない方針に変更した (validateProjectCwd 参照:
 * 本来のリスクは Castra 自体への破壊的 git 操作であって、 cwd の選択そのものではない)。
 * root 群の解決先は残しておき、 Castra 向けの操作ガードが将来 cwd 判定を必要とする
 * 場合に再利用できるようにする。
 */
export function setWorkspaceRootsResolver(fn: () => string[]): void {
  workspaceRootsResolver = fn;
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
 * cmd.exe へ 1 つのコマンドラインとして渡す文字列を組み立てる際に、 引数中の
 * シェルメタ文字 (`&` `|` `<` `>` `^` `%` `"` `!` 等) がコマンド区切り/
 * リダイレクト/変数展開として解釈されるのを防ぐエスケープ (CWE-78 対策)。
 *
 * cmd.exe には `/C` に渡された文字列全体が単一の引用符ペアで囲まれていると
 * その外側の引用符を剥がして中身を無引用のコマンドラインとして再解析する
 * 既知の挙動がある (https://qntm.org/cmd)。 単純に `"arg"` で囲むだけでは
 * 引数中に `&` 等が残っていればこの再解析で有効なコマンド区切りとして
 * 実行されてしまうため不十分。 ここでは cross-spawn が Windows shell 経由の
 * 引数エスケープに使うのと同じアルゴリズムを用いる: 引用符で囲んだ上で
 * 引用符自身を含む全メタ文字に `^` を前置する。 こうすると cmd.exe の
 * パーサは終始「無引用」モードのまま `^` エスケープを解決し、 最終的に
 * 元の引数を安全な二重引用符付きトークンとして子プロセスへ渡す。
 */
export function escapeCmdArg(arg: string): string {
  let out = String(arg);
  // 末尾のバックスラッシュ列の直後に引用符を置くと、 バックスラッシュが
  // 引用符のエスケープとして食われてしまうため先に倍化しておく。
  out = out.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\*)$/, "$1$1");
  out = `"${out}"`;
  out = out.replace(/([()%!^"<>&|;,\s])/g, "^$1");
  return out;
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
  // provider/args は外部入力 (spawn API 経由) になり得るため、 結合前に
  // 各トークンを escapeCmdArg でエスケープしコマンドインジェクションを防ぐ
  // (CWE-78; 継続 2 日目の critical 指摘対応)。
  const providerParts = [req.provider, ...(req.args ?? [])];
  const escapedCommand = [...launcher, ...providerParts].map(escapeCmdArg).join(" ");
  out.push("cmd.exe", "/d", "/s", "/c", escapedCommand + " & exit 0");
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
  if (explicit) {
    const root = (defaultCwd ?? "").trim();
    return root && normalizePath(explicit) === normalizePath(root) ? "" : explicit;
  }
  // Castra/workspace root is a repository container, not a Session working
  // directory. Keep the legacy helper for API compatibility but never infer
  // a cwd from the workspace root.
  void defaultCwd;
  return "";
}

export function resolveAgentHomeCwd(
  provider: SpawnProvider,
  requested: unknown,
  defaultCwd: string | undefined | null,
): string | undefined {
  if (typeof requested === "string" && requested.trim()) {
    return resolveSpawnCwd(requested, defaultCwd);
  }
  void provider;
  // Missing project is an error at spawnSession. Never silently start in
  // Castra or Concordia's own process.cwd().
  return undefined;
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

/**
 * Build the environment passed to an interactive child session.
 *
 * Revisor's workflow token is a Concordia service credential.  Never inherit
 * it ambiently: the Test Forum route explicitly adds it to `req.env` only for
 * the scoped verification session that needs to call Revisor mutations.
 */
export function buildSessionSpawnEnvironment(
  req: SpawnRequest,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  spawnId: string = req.spawnId?.trim() || randomUUID(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inheritedEnv };
  delete env.CONCORDIA_REVISOR_WORKFLOW_TOKEN;
  return {
    ...env,
    ...sanitizeSpawnEnv(req.env),
    ...buildSpawnIdentityEnv(req, spawnId),
    ...currentConcordiaAddressEnv(),
  };
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

/**
 * Central three-out guard: every launcher path eventually calls spawnSession,
 * so an omitted cwd is rejected in one place.
 *
 * Using the workspace root (Castra) itself as a Session cwd is intentionally
 * ALLOWED: cross-repo / coordination sessions legitimately start there (see
 * conflict-scope.ts's "umbrella" handling, which already assumes root-cwd
 * sessions are normal). Blocking it here treated Castra as an off-limits
 * competitor rather than guarding the actual risk — destructive git
 * operations against Castra's own working tree (commit / push / checkout /
 * reset, etc.), not the choice of cwd. That risk is guarded separately:
 * session-work-policy.ts injects a fail-closed advisory into every Session
 * warning against destructive git ops on Castra, on top of the org-wide
 * branch→PR / no-direct-main-push convention (CLAUDE.md).
 */
export function validateProjectCwd(
  cwd: string | undefined,
  workspaceRoots: readonly string[] = currentWorkspaceRoots(),
): string | null {
  const value = cwd?.trim();
  if (!value) return "project cwd is required; select a project before spawning a Session";
  // Kept for signature stability / a potential future Castra-operation guard;
  // no longer used to reject workspace-root cwds (see comment above).
  void workspaceRoots;
  return null;
}

function currentWorkspaceRoots(): string[] {
  if (workspaceRootsResolver) {
    try {
      return workspaceRootsResolver();
    } catch {
      // Fall through to process env so a transient AdminState read cannot
      // disable the safety boundary.
    }
  }
  return [
    process.env.CONCORDIA_WORKSPACE_ROOT ?? "",
    ...((process.env.CONCORDIA_WORKSPACE_ROOTS ?? "").split(";")),
    process.env.LUDIARS_ROOT ?? "",
  ].filter((value) => value.trim().length > 0);
}

function normalizePath(value: string): string {
  return resolvePath(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Pure: codex-sdk (Satelles) の argv を組み立てる。
 * 委託 (CONCORDIA_DELEGATION_PROMPT_FILE がある) は one-shot `run`、
 * それ以外の対話 spawn は常駐 `serve`。 prompt 自体は env 契約で渡るので
 * argv には現れない。 model / effort は resolveDelegationSpawn /
 * resolveDelegationRuntimeArgs が `--model` / `--effort` として req.args に積む。
 */
export function buildSatellesArgs(req: SpawnRequest, launcher: string[] = ["satelles"]): string[] {
  const subcommand = req.env?.CONCORDIA_DELEGATION_PROMPT_FILE ? "run" : "serve";
  return [...launcher, subcommand, ...(req.args ?? [])];
}

/**
 * headless spawn の argv トークン検証 (Windows では cmd.exe 経由で走る)。 実際の
 * 無害化は buildHeadlessCmdArgs の escapeCmdArg が行い、 これはその手前の
 * fail-fast な追加防御。
 * `%` を落とすのが要点: cmd.exe の `%VAR%` 展開は `^` エスケープより前段で走るため
 * escapeCmdArg でも塞ぎきれず、 通せば親プロセスの環境変数値 (認証情報を含み得る) が
 * 子のコマンドラインへ混入する。
 */
const HEADLESS_ARG_UNSAFE_RE = /[\0\r\n&|<>^"%]/u;

/**
 * Pure: headless spawn を Windows の cmd.exe 経由で起動するときの argv。
 *
 * wt.exe 経路 (buildWtArgs) と同じく全トークンを escapeCmdArg で無害化してから
 * 1 本のコマンドラインに結合する。 理由は 2 つ:
 *
 *  1. CWE-78: `/v1/spawn` の `args` は外部入力として子のコマンドラインへ届く。
 *     denylist は `(` `)` `,` `;` 等 cmd.exe のトークン分割文字を素通しするので、
 *     経路ごとに別ロジックを持たず wt.exe 経路と同じエスケープに揃える。
 *  2. libuv 既定のクォート (arg に空白があれば `"` で囲む) は cmd.exe の `/s`
 *     (先頭が引用符ならコマンドライン全体の先頭と末尾の引用符を剥がす) と噛み合わず、
 *     空白を含む launcher パス — `CONCORDIA_SATELLES_LAUNCHER` で dev checkout を
 *     指す想定の主用途 — で起動が壊れる。 escapeCmdArg の出力は `^"` 始まりなので
 *     `/s` の剥がし条件に触れない。
 *
 * 呼び出し側は `windowsVerbatimArguments: true` で渡すこと (Node に再クォートさせない)。
 */
export function buildHeadlessCmdArgs(tokens: readonly string[]): string[] {
  return ["/d", "/s", "/c", tokens.map(escapeCmdArg).join(" ")];
}

function spawnHeadlessSession(req: SpawnRequest): SpawnResult {
  const tokens = buildSatellesArgs(req, currentSatellesLauncher());
  for (const token of tokens) {
    if (HEADLESS_ARG_UNSAFE_RE.test(token)) {
      return { ok: false, error: `unsafe character in headless spawn token: ${token.slice(0, 40)}` };
    }
  }
  const env = buildSessionSpawnEnvironment(req);
  const isWindows = process.platform === "win32";
  const file = isWindows ? process.env.ComSpec ?? "cmd.exe" : tokens[0]!;
  const args = isWindows ? buildHeadlessCmdArgs(tokens) : tokens.slice(1);
  let child: ReturnType<typeof spawn>;
  try {
    // detached + stdio "ignore" — 親 (Concordia) の stdio を継承させない
    // (detached inherit は Excubitor EBADF ループの実害があった構成)。
    child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      cwd: req.cwd,
      env,
      windowsHide: true,
      // buildHeadlessCmdArgs が既にエスケープ済み。 Node に再クォートさせると
      // `/s` の引用符剥がしと干渉する (POSIX では無視される)。
      windowsVerbatimArguments: isWindows,
    });
  } catch (err) {
    const msg = `satelles spawn failed: ${(err as Error).message}`;
    log.error({ err }, msg);
    reportError("spawner", msg, { provider: req.provider, cwd: req.cwd });
    return { ok: false, error: msg };
  }
  child.on("error", (err) => {
    const msg = `satelles spawn error: ${err.message}`;
    log.error({ err }, msg);
    reportError("spawner", msg, { provider: req.provider, cwd: req.cwd });
  });
  try {
    child.unref();
  } catch {
    // best-effort
  }
  return { ok: true, command: tokens, pid: child.pid ?? null };
}

export function spawnSession(req: SpawnRequest): SpawnResult {
  const isHeadless = HEADLESS_SPAWN_PROVIDERS.has(req.provider);
  if (!isHeadless && process.platform !== "win32") {
    return { ok: false, error: "spawn currently requires Windows + Windows Terminal (wt.exe)" };
  }
  const projectCwdErr = validateProjectCwd(req.cwd);
  if (projectCwdErr) return { ok: false, error: projectCwdErr };
  const cwdErr = validateCwd(req.cwd);
  if (cwdErr) return { ok: false, error: cwdErr };
  if (isHeadless) return spawnHeadlessSession(req);

  const args = buildWtArgs(req, currentLictorLauncher());
  // CWE-78 対策: 外部入力 env を子プロセスへ素通ししない。 公開 spawn API は env を
  // 受け取らない (HTTP ハンドラ側で破棄) ようにしたうえで、 ここでも防御的に
  // Concordia 自身が設定する allowlist key (LICTOR_* / CONCORDIA_*) のみ通す。
  // NODE_OPTIONS / LD_PRELOAD / PATH 等の loader 系を注入されると lictor 経由 Node の
  // 任意コード実行に至るため、 prefix allowlist でそれらを構造的に排除する。
  // CONCORDIA_HOST / CONCORDIA_PORT は最後に Concordia 自身の listen アドレスで上書きし、
  // ambient env の継承に頼らず spawning Concordia を必ず指すようにする。
  const env = buildSessionSpawnEnvironment(req);
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
