/**
 * 委託 (delegation / template spawn) の Codex を **headless `codex exec`** で走らせる。
 *
 * Lictor の PTY ラップ + prompt inject は Claude Code 向けの作りで、 Codex を対話 TUI
 * として起動すると trust / approval プロンプトで人間待ちブロックし前進しない (2026-07-07
 * 調査)。 Codex 委託は対話 TUI をやめ、 既存の headless ランナー
 * `tools/concordia-codex-worker.mjs` (`codex exec --json`、 self-register + cost 記録を
 * 自前完結) を非GUI (wt.exe を経由しない) で起動する。
 *
 * SpawnRequest を受けて {@link spawnSession} と同じ {@link SpawnResult} を返すので、
 * delegation の spawner を provider で分岐するだけで載せ替えられる。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { reportError } from "../errors.js";
import { createChildLogger } from "../shared/logger.js";
import type { SpawnRequest, SpawnResult } from "./spawner.js";

const log = createChildLogger("codex-worker-spawn");

/** SpawnRequest.args から `--model <v>` の値を取り出す (pure)。 */
export function extractModelArg(args: readonly string[] | undefined): string | null {
  if (!args) return null;
  const i = args.indexOf("--model");
  if (i >= 0 && i + 1 < args.length) return args[i + 1] ?? null;
  return null;
}

/** SpawnRequest.args の `-c model_reasoning_effort="high"` から effort を取り出す (pure)。 */
export function extractReasoningEffort(args: readonly string[] | undefined): string | null {
  if (!args) return null;
  for (const a of args) {
    const m = /^model_reasoning_effort=(.+)$/.exec(a);
    if (m) return m[1]!.replace(/^"(.*)"$/, "$1");
  }
  return null;
}

/** headless codex worker (`concordia-codex-worker.mjs`) の argv を組む (pure・テスト用)。 */
export function buildCodexWorkerArgs(
  workerScript: string,
  req: SpawnRequest,
  promptFile: string,
): string[] {
  const model = extractModelArg(req.args);
  const reasoning = extractReasoningEffort(req.args);
  const args = [workerScript];
  if (req.cwd) args.push(`--cd=${req.cwd}`);
  args.push(`--prompt-file=${promptFile}`);
  if (model) args.push(`--model=${model}`);
  if (reasoning) args.push(`--reasoning=${reasoning}`);
  // codex exec は非対話 (approval プロンプト無し)。 sandbox だけが権限を決める。 委託は
  // PR (git push / gh = network) を作るため network 込みの full-access で自律実行する
  // (委託先はユーザのローカル = externally trusted 環境)。
  args.push("--sandbox=danger-full-access");
  return args;
}

export interface CodexWorkerSpawnOptions {
  /** worker スクリプトの絶対パス。 省略時は repoRoot/tools/concordia-codex-worker.mjs。 */
  workerScript?: string;
  /** Concordia リポルート。 省略時は process.cwd()。 */
  repoRoot?: string;
  /** node 実行ファイル。 省略時は process.execPath。 */
  nodeBin?: string;
  /** テスト用 spawn 差し替え。 */
  spawnFn?: typeof spawn;
}

/**
 * codex 委託を headless worker で spawn する。 GUI (wt.exe) は経由しない。
 * prompt は worker に `--prompt-file` で直接読ませる (env `CONCORDIA_DELEGATION_PROMPT_FILE`)。
 */
export function spawnCodexExecWorker(req: SpawnRequest, opts: CodexWorkerSpawnOptions = {}): SpawnResult {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const workerScript = opts.workerScript ?? join(repoRoot, "tools", "concordia-codex-worker.mjs");
  if (!existsSync(workerScript)) {
    return { ok: false, error: `codex worker script not found: ${workerScript}` };
  }
  const promptFile = req.env?.CONCORDIA_DELEGATION_PROMPT_FILE;
  if (!promptFile) {
    return { ok: false, error: "codex worker requires CONCORDIA_DELEGATION_PROMPT_FILE in env" };
  }
  if (!existsSync(promptFile)) {
    return { ok: false, error: `codex worker prompt file not found: ${promptFile}` };
  }

  const nodeBin = opts.nodeBin ?? process.execPath;
  const args = buildCodexWorkerArgs(workerScript, req, promptFile);
  const spawnFn = opts.spawnFn ?? spawn;
  // spawn 失敗は非同期 `error` イベントで届く。 リスナー無しだと uncaughtException
  // として Concordia 本体を巻き込むため、 同期 throw と合わせて必ず捕捉する。
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnFn(nodeBin, args, {
      cwd: req.cwd || repoRoot,
      detached: true,
      // worker は self-register で Concordia に状態を送るので、 親は出力を待たない。
      stdio: "ignore",
      env: { ...process.env, ...(req.env ?? {}) },
      windowsHide: true,
    });
  } catch (err) {
    const msg = `codex worker spawn failed: ${(err as Error).message}`;
    log.error({ err }, msg);
    reportError("codex-worker-spawn", msg, { cwd: req.cwd });
    return { ok: false, error: msg };
  }
  child.on("error", (err) => {
    const msg = `codex worker spawn error: ${err.message}`;
    log.error({ err }, msg);
    reportError("codex-worker-spawn", msg, { cwd: req.cwd });
  });
  try {
    child.unref();
  } catch {
    // best-effort
  }
  return { ok: true, command: [nodeBin, ...args], pid: child.pid ?? null };
}
