/**
 * ホストのパフォーマンススナップショットを 1 回採取する。
 *
 * - host: 物理メモリ (os) + CPU 使用率 (os.cpus の 200ms デルタ)
 * - topProcesses: image 名で RSS 合算した上位
 * - sessions: active/lost セッションごとに lictor_pid の部分木 RSS (= セッション別メモリ)
 *
 * Concordia が自前で見るのは Lictor セッションの消費だけにする。 WSL / docker の
 * バックエンド監視は Excubitor が担当し、 必要ならそちらから受け取る。 自前で
 * `wsl.exe` / `docker` を spawn するのをやめたのは、 WSL backend が刺さると
 * プローブが返らず、 timeout で刈り取っても `wslservice` のハンドルと孤児
 * `wslhost.exe` が tick ごとに積み上がったため (2026-08-01: wslservice が
 * 19,000 ハンドル超、 孤児 5 本、 2 分で wsl.exe 起動 36 回)。
 */

import os from "node:os";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ExcubitorClient } from "../excubitor/client.js";
import { parseLictorPid } from "../control/reaper.js";
import { listProcesses, sumTreeRss, topByName, type TopProc } from "./process-tree.js";
import type { LagSnapshot } from "./event-loop-lag.js";

export interface SessionMem {
  session_id: string;
  label: string;
  repo_path: string;
  status: string;
  rss: number;
  procCount: number;
  pid: number;
}

export interface HostSnapshot {
  sampled_at: number;
  host: {
    totalMem: number;
    usedMem: number;
    freeMem: number;
    cpuCount: number;
    /** CPU 使用率 0-100、 取得不能なら null。 */
    loadPct: number | null;
  };
  topProcesses: TopProc[];
  sessions: SessionMem[];
  /** Event-loop lag (ms)。 Phase 3 分離効果の物差し。 */
  eventLoopLag?: LagSnapshot;
}

export async function collectHostSnapshot(
  repo: SessionsRepo,
  nowMs: number,
  excubitorClient?: ExcubitorClient,
): Promise<HostSnapshot> {
  const procList = await listProcesses(excubitorClient, nowMs);
  const loadPct = await cpuLoadPct();

  const total = os.totalmem();
  const free = os.freemem();

  const sessions: SessionMem[] = [];
  if (procList) {
    for (const status of ["active", "lost"] as const) {
      for (const s of repo.listSessions({ status })) {
        const pid = parseLictorPid(s.metadata);
        if (pid == null) continue;
        const tree = sumTreeRss(procList, pid);
        if (tree.procCount === 0) continue; // プロセス不在 (終了済) は載せない
        sessions.push({
          session_id: s.id,
          label: s.current_task?.slice(0, 60) || basename(s.repo_path),
          repo_path: s.repo_path,
          status,
          rss: tree.rssBytes,
          procCount: tree.procCount,
          pid,
        });
      }
    }
    sessions.sort((a, b) => b.rss - a.rss);
  }

  return {
    sampled_at: nowMs,
    host: {
      totalMem: total,
      usedMem: total - free,
      freeMem: free,
      cpuCount: os.cpus().length,
      loadPct,
    },
    topProcesses: procList ? topByName(procList, 15) : [],
    sessions,
  };
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

/** os.cpus() の 200ms デルタで全体 CPU 使用率 (%) を測る。 */
async function cpuLoadPct(): Promise<number | null> {
  try {
    const a = cpuTotals();
    await sleep(200);
    const b = cpuTotals();
    const dt = b.total - a.total;
    const di = b.idle - a.idle;
    if (dt <= 0) return null;
    return Math.round((1 - di / dt) * 100);
  } catch {
    return null;
  }
}

function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times) as Array<keyof typeof c.times>) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
