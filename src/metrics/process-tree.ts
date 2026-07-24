/**
 * プロセスツリーの RSS サンプリング。
 *
 * セッション別メモリは「Lictor の pid (sessions.metadata.lictor_pid) を根とする部分木の RSS」。
 * `npm`/cmd ラッパ経由で起動するため pid 単体では取りこぼす。全プロセス走査は Excubitor が
 * 一元管理し、Concordia は共有 snapshot の (pid, ppid, rss, name) から木構造で合算する。
 */

import {
  ExcubitorClient,
  MAX_PROCESS_SNAPSHOT_AGE_MS,
  type ExcubitorProcessSnapshot,
} from "../excubitor/client.js";

export interface ProcEntry {
  pid: number;
  ppid: number;
  /** 常駐セット (Windows=WorkingSetSize, POSIX=RSS) バイト。 */
  rss: number;
  name: string;
}

export interface TreeRss {
  rssBytes: number;
  procCount: number;
}

/** Windows PowerShell CSV "pid,ppid,ws,name" を parse (pure)。 name にカンマは無い前提で末尾を name。 */
export function parseWindowsProcs(raw: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rss = Number(parts[2]);
    const name = parts.slice(3).join(",").trim();
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rss)) continue;
    out.push({ pid, ppid, rss, name });
  }
  return out;
}

/** POSIX `ps -eo pid=,ppid=,rss=,comm=` を parse (pure)。 rss は KB。 */
export function parsePosixProcs(raw: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, name: m[4]!.trim() });
  }
  return out;
}

/** rootPid を根とする部分木 (自身 + 全子孫) の RSS を合算 (pure)。 cycle 安全。 */
export function sumTreeRss(procs: ProcEntry[], rootPid: number): TreeRss {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    if (p.ppid !== p.pid) {
      const arr = children.get(p.ppid) ?? [];
      arr.push(p.pid);
      children.set(p.ppid, arr);
    }
  }
  if (!byPid.has(rootPid)) return { rssBytes: 0, procCount: 0 };
  let rssBytes = 0;
  let procCount = 0;
  const visited = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const e = byPid.get(pid);
    if (!e) continue;
    rssBytes += e.rss;
    procCount += 1;
    for (const ch of children.get(pid) ?? []) if (!visited.has(ch)) stack.push(ch);
  }
  return { rssBytes, procCount };
}

export interface TopProc {
  name: string;
  rss: number;
  count: number;
}

/** image 名で RSS を合算し降順 top N (pure)。 */
export function topByName(procs: ProcEntry[], limit = 15): TopProc[] {
  const agg = new Map<string, { rss: number; count: number }>();
  for (const p of procs) {
    const e = agg.get(p.name) ?? { rss: 0, count: 0 };
    e.rss += p.rss;
    e.count += 1;
    agg.set(p.name, e);
  }
  return [...agg.entries()]
    .map(([name, v]) => ({ name, rss: v.rss, count: v.count }))
    .sort((a, b) => b.rss - a.rss)
    .slice(0, limit);
}

/** Excubitor API の wire model をメトリクス用の最小形へ変換する (pure)。 */
export function procEntriesFromSnapshot(snapshot: ExcubitorProcessSnapshot): ProcEntry[] {
  return snapshot.processes
    .filter((process) =>
      Number.isFinite(process.pid)
      && Number.isFinite(process.ppid)
      && Number.isFinite(process.rss),
    )
    .map((process) => ({
      pid: process.pid,
      ppid: process.ppid,
      rss: process.rss,
      name: process.name || "(unknown)",
    }));
}

/** Excubitor の共有 snapshot を取得する。失敗・stale 時は null (ローカル走査へ fallback しない)。 */
export async function listProcesses(
  client = new ExcubitorClient(),
  nowMs = Date.now(),
): Promise<ProcEntry[] | null> {
  try {
    const snapshot = await client.getProcessSnapshot();
    if (!Number.isFinite(snapshot.sampled_at) || nowMs - snapshot.sampled_at > MAX_PROCESS_SNAPSHOT_AGE_MS) {
      return null;
    }
    return procEntriesFromSnapshot(snapshot);
  } catch {
    return null;
  }
}
