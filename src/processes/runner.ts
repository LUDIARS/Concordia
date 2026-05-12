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

const log = createChildLogger("runner");

export interface RunnerInput {
  name: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  log_path: string;
  error_patterns?: string[];
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
  /** SIGTERM を送る. timeoutMs 後に SIGKILL fallback. */
  stop: (timeoutMs?: number) => Promise<void>;
  /** ringbuffer のスナップショット (新→古). */
  snapshot: () => LogEntry[];
}

export function spawnProcess(input: RunnerInput): RunnerHandle {
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

  const child: ChildProcess = spawn(input.command, {
    cwd: input.cwd,
    env: input.env ? { ...process.env, ...input.env } : process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  eventBus.emit({
    type: "process.started",
    process_name: input.name,
    pid: child.pid ?? -1,
    cwd: input.cwd,
    command: input.command,
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
    snapshot: () => ring.slice(),
    stop: (timeoutMs = 5000) =>
      new Promise<void>((resolve) => {
        if (child.exitCode != null || child.signalCode != null) {
          resolve();
          return;
        }
        let killed = false;
        const onExit = () => { if (!killed) { killed = true; resolve(); } };
        child.once("close", onExit);
        try { child.kill("SIGTERM"); } catch { /* swallow */ }
        setTimeout(() => {
          if (!killed) {
            try { child.kill("SIGKILL"); } catch { /* swallow */ }
          }
        }, timeoutMs);
      }),
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
