/**
 * ProcessManager — Concordia から spawn された全プロセスの hub.
 *
 * - start(): repo の dev-process.md を読み込んで auto_start のものだけ立ち上げる
 *   (既に running なものは skip).
 * - startOne(): 単発 API 起動 (dev-process.md に無い ad-hoc 起動も可).
 * - stopOne(): 走行中なら SIGTERM → SIGKILL.
 * - 監視: child の exit を runner.onExit から受け取り、 DB を更新する.
 *
 * runner / dev-process-md / repo / file-system が分担:
 *   manager  — 整流弁. 「同名は 1 つ」「dev-process.md を起点に並べる」
 *   runner   — spawn の薄ラッパ
 *   repo     — 永続化 (processes / process_logs)
 */

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { ProcessesRepo } from "../db/processes-repo.js";
import { createChildLogger } from "../shared/logger.js";
import {
  type ProcessDef,
  readDevProcessMd,
} from "./dev-process-md.js";
import { spawnProcess, type LogEntry, type RunnerHandle } from "./runner.js";

const log = createChildLogger("processes");

export interface ManagerDeps {
  repo: ProcessesRepo;
  /** ログファイル群を置く dir (絶対). 既定 <cwd>/logs */
  logsDir: string;
}

export interface StartOneInput {
  name: string;
  command: string;
  /** 絶対パス. dev-process.md 由来は manager が解決済の絶対パスを渡す. */
  cwd: string;
  env?: Record<string, string>;
  error_patterns?: string[];
  /** dev-process.md がある repo の絶対パス. ad-hoc 起動時は null. */
  repo_path?: string | null;
  repo_origin?: string | null;
}

export interface StartOneResult {
  ok: boolean;
  reason?: string;
  pid?: number;
}

export class ProcessManager {
  private handles = new Map<string, RunnerHandle>();

  constructor(private readonly deps: ManagerDeps) {
    try { mkdirSync(deps.logsDir, { recursive: true }); } catch { /* swallow */ }
  }

  isRunning(name: string): boolean {
    return this.handles.has(name);
  }

  listRunning(): RunnerHandle[] {
    return [...this.handles.values()];
  }

  /**
   * repo_path / dev-process.md を見て auto_start のプロセスをまとめて起動.
   * 既に running なら skip. parse 警告は warnings として返す.
   */
  startFromRepo(repoPath: string, repoOrigin: string | null = null): {
    started: string[];
    skipped: string[];
    failed: { name: string; reason: string }[];
    warnings: string[];
    marker_only: boolean;
    devProcessMdPath: string | null;
  } {
    const file = readDevProcessMd(repoPath);
    const result = {
      started: [] as string[],
      skipped: [] as string[],
      failed: [] as { name: string; reason: string }[],
      warnings: file.warnings,
      marker_only: file.exists && file.processes.length === 0,
      devProcessMdPath: file.path,
    };
    if (!file.exists) return result;

    for (const def of file.processes) {
      const auto = def.auto_start ?? true;
      if (!auto) {
        result.skipped.push(def.name);
        continue;
      }
      if (this.isRunning(def.name)) {
        result.skipped.push(def.name);
        continue;
      }
      const cwd = resolveCwd(repoPath, def.cwd);
      const r = this.startOne({
        name: def.name,
        command: def.command,
        cwd,
        env: def.env,
        error_patterns: def.error_patterns,
        repo_path: repoPath,
        repo_origin: repoOrigin,
      });
      if (r.ok) result.started.push(def.name);
      else result.failed.push({ name: def.name, reason: r.reason ?? "unknown" });
    }
    return result;
  }

  startOne(input: StartOneInput): StartOneResult {
    if (this.handles.has(input.name)) {
      return { ok: false, reason: "already_running" };
    }
    if (!existsSync(input.cwd)) {
      return { ok: false, reason: `cwd_not_found: ${input.cwd}` };
    }
    const logPath = join(this.deps.logsDir, `${safeFileName(input.name)}.log`);
    const meta = JSON.stringify({
      env: input.env ?? null,
      error_patterns: input.error_patterns ?? null,
    });
    this.deps.repo.upsert({
      name: input.name,
      cwd: input.cwd,
      command: input.command,
      repo_path: input.repo_path ?? null,
      repo_origin: input.repo_origin ?? null,
      log_path: logPath,
      metadata: meta,
    });

    let handle: RunnerHandle;
    try {
      handle = spawnProcess({
        name: input.name,
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        log_path: logPath,
        error_patterns: input.error_patterns,
        onLine: (entry: LogEntry) => {
          try {
            this.deps.repo.appendLog({
              process_name: input.name,
              ts: entry.ts,
              stream: entry.stream,
              level: entry.level,
              line: entry.line.slice(0, 4096),
            });
          } catch (err) {
            log.warn({ err, name: input.name }, "appendLog failed");
          }
        },
        onExit: (info) => {
          this.handles.delete(input.name);
          try {
            this.deps.repo.setExited(input.name, info);
          } catch (err) {
            log.warn({ err, name: input.name }, "setExited failed");
          }
        },
      });
    } catch (err) {
      this.deps.repo.setExited(input.name, {
        exit_code: null,
        exit_signal: null,
        exited_at: Math.floor(Date.now() / 1000),
        failed: true,
      });
      return { ok: false, reason: `spawn_failed: ${(err as Error).message}` };
    }

    this.handles.set(input.name, handle);
    if (handle.pid > 0) {
      this.deps.repo.setStarted(input.name, handle.pid, Math.floor(Date.now() / 1000));
    }
    return { ok: true, pid: handle.pid };
  }

  async stopOne(name: string, timeoutMs = 5000): Promise<{ ok: boolean; reason?: string }> {
    const h = this.handles.get(name);
    if (!h) return { ok: false, reason: "not_running" };
    await h.stop(timeoutMs);
    this.handles.delete(name);
    return { ok: true };
  }

  /** プロセスエントリ + 関連ログを完全削除. 走行中なら停止してから. */
  async remove(name: string): Promise<void> {
    if (this.handles.has(name)) await this.stopOne(name);
    this.deps.repo.remove(name);
  }

  /** shutdown 時の一括停止. */
  async stopAll(timeoutMs = 5000): Promise<void> {
    const names = [...this.handles.keys()];
    await Promise.all(names.map((n) => this.stopOne(n, timeoutMs)));
  }
}

function resolveCwd(repoPath: string, sub?: string): string {
  if (!sub || sub === "." || sub === "./") return repoPath;
  if (isAbsolute(sub)) return sub;
  return resolvePath(repoPath, sub);
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
