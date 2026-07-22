/**
 * Process runner — child_process.spawn のラッパ.
 *
 * 1 ProcessHandle = 1 spawned shell プロセス. stdout/stderr を行単位で:
 *   1. in-memory ringbuffer (直近 N 行) に push
 *   2. ファイル `<log_path>` に追記
 *   3. eventBus に process.log を emit
 *   4. error pattern にヒットしたら level="error" を付ける
 *
 * exit handler で eventBus に process.exited を emit し、 onExit() を呼ぶ.
 *
 * shell: true で起動するので command は単一行コマンドラインで OK.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import type { LogLevel, LogStream } from "../shared/types.js";
import { DEFAULT_ERROR_PATTERNS } from "./dev-process-md.js";
import type { ProcessCommandManifest } from "./dev-process-md.js";
import { randomUUID } from "node:crypto";

const log = createChildLogger("runner");

export interface RunnerInput {
  name: string;
  command: ProcessCommandManifest;
  cwd: string;
  env?: Record<string, string>;
  log_path: string;
  error_patterns?: string[];
  instance_id?: string;
  generation?: number;
  /** in-memory ringbuffer サイズ. 既定 1000 行. */
  ring_size?: number;
  /** 行ごとに呼ばれる callback. 永続化や log GC のフック用. */
  onLine?: (entry: LogEntry) => void;
  /** 終了時に呼ばれる. failed=true なら exit_code != 0 や signal 終了. */
  onExit?: (info: ExitInfo) => void;
}

export interface LogEntry {
  ts: number;
  stream: LogStream;
  level: LogLevel | null;
  line: string;
}

export interface ExitInfo {
  exit_code: number | null;
  exit_signal: string | null;
  exited_at: number;
  failed: boolean;
}

export interface RunnerHandle {
  name: string;
  pid: number;
  instance_id: string;
  generation: number;
  /** SIGTERM を送る. timeoutMs 後に SIGKILL fallback. */
  stop: (timeoutMs?: number) => Promise<void>;
  /** ringbuffer のスナップショット (新→古). */
  snapshot: () => LogEntry[];
}

export function windowsTreeKillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

export function spawnProcess(input: RunnerInput): RunnerHandle {
  const instanceId = input.instance_id ?? randomUUID();
  const generation = input.generation ?? 1;
  const errorPatterns = (input.error_patterns ?? DEFAULT_ERROR_PATTERNS).map(
    (p) => new RegExp(p, "i"),
  );
  const ringSize = input.ring_size ?? 1000;
  const ring: LogEntry[] = [];

  // ログファイルの dir を作っておく.
  try { mkdirSync(dirname(input.log_path), { recursive: true }); } catch { /* swallow */ }
  let logFile: WriteStream | null = null;
  try {
    logFile = createWriteStream(input.log_path, { flags: "a" });
    logFile.on("error", (err) => log.warn({ err, name: input.name }, "log file error"));
  } catch (err) {
    log.warn({ err, name: input.name }, "failed to open log file");
  }

  const child: ChildProcess = spawn(input.command.file, input.command.args, {
    cwd: input.cwd,
    env: input.env ? { ...process.env, ...input.env } : process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  eventBus.emit({
    type: "process.started",
    process_name: input.name,
    pid: child.pid ?? -1,
    cwd: input.cwd,
    command: JSON.stringify(input.command),
    ts: nowSec(),
  });

  if (child.stdout) attachLineReader(child.stdout, "stdout");
  if (child.stderr) attachLineReader(child.stderr, "stderr");

  child.on("error", (err) => {
    pushLine("event", null, `[runner] spawn error: ${err.message}`);
  });

  child.on("close", (code, signal) => {
    const failed = (code != null && code !== 0) || !!signal;
    const info: ExitInfo = {
      exit_code: code,
      exit_signal: signal,
      exited_at: nowSec(),
      failed,
    };
    pushLine("event", failed ? "error" : "info",
      `[runner] exited code=${code ?? "?"} signal=${signal ?? "-"}`);
    eventBus.emit({
      type: "process.exited",
      process_name: input.name,
      exit_code: code,
      signal,
      ts: info.exited_at,
    });
    if (logFile) {
      try { logFile.end(); } catch { /* swallow */ }
    }
    input.onExit?.(info);
  });

  function attachLineReader(stream: NodeJS.ReadableStream, kind: LogStream) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        const level = classify(line, kind);
        pushLine(kind, level, line);
      }
    });
    stream.on("end", () => {
      if (buf.length > 0) {
        const level = classify(buf, kind);
        pushLine(kind, level, buf);
        buf = "";
      }
    });
  }

  function classify(line: string, stream: LogStream): LogLevel | null {
    if (errorPatterns.some((re) => re.test(line))) return "error";
    if (stream === "stderr") return "warn";
    return null;
  }

  function pushLine(stream: LogStream, level: LogLevel | null, line: string) {
    const entry: LogEntry = { ts: nowSec(), stream, level, line };
    ring.unshift(entry);
    if (ring.length > ringSize) ring.length = ringSize;
    if (logFile) {
      try {
        logFile.write(
          `${new Date(entry.ts * 1000).toISOString()} [${stream}${level ? ":" + level : ""}] ${line}\n`,
        );
      } catch { /* swallow */ }
    }
    eventBus.emit({
      type: "process.log",
      process_name: input.name,
      stream,
      line,
      level: level ?? undefined,
      ts: entry.ts,
    });
    input.onLine?.(entry);
  }

  return {
    name: input.name,
    pid: child.pid ?? -1,
    instance_id: instanceId,
    generation,
    snapshot: () => ring.slice(),
    stop: (timeoutMs = 5000) =>
      new Promise<void>((resolve) => {
        if (child.exitCode != null || child.signalCode != null) {
          resolve();
          return;
        }
        let killed = false;
        let fallback: NodeJS.Timeout | null = null;
        let hardDeadline: NodeJS.Timeout | null = null;
        const onExit = () => {
          if (killed) return;
          killed = true;
          if (fallback) clearTimeout(fallback);
          if (hardDeadline) clearTimeout(hardDeadline);
          resolve();
        };
        child.once("close", onExit);
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", windowsTreeKillArgs(child.pid), {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", (error) => {
            log.warn({ err: error.message, name: input.name, pid: child.pid }, "taskkill tree failed");
            try { child.kill("SIGKILL"); } catch { /* swallow */ }
          });
        } else {
          try { child.kill("SIGTERM"); } catch { /* swallow */ }
        }
        fallback = setTimeout(() => {
          if (!killed) {
            try { child.kill("SIGKILL"); } catch { /* swallow */ }
          }
        }, timeoutMs);
        hardDeadline = setTimeout(onExit, timeoutMs + 1000);
        fallback.unref?.();
        hardDeadline.unref?.();
      }),
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
