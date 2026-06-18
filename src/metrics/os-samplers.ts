/**
 * WSL / docker のメモリサンプラ (host 概況用)。 失敗時は空配列で degrade。
 */

import { runCapture } from "./process-tree.js";

export interface WslSample {
  key: string;          // distro 名 | 'vmmem'
  side: "guest" | "host";
  rss: number;          // guest=使用量, host=vmmem WorkingSet
  total?: number;       // guest のみ: MemTotal
}

export interface DockerSample {
  name: string;
  rss: number;
  percent: number | null;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1, kb: 1000, kib: 1024, mb: 1000 ** 2, mib: 1024 ** 2,
  gb: 1000 ** 3, gib: 1024 ** 3, tb: 1000 ** 4, tib: 1024 ** 4,
};

/** "123.4MiB" → バイト (pure)。 */
export function parseSize(s: string): number | null {
  const m = s.trim().match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z]+)$/);
  if (!m) return null;
  const f = SIZE_UNITS[m[2]!.toLowerCase()];
  const v = Number(m[1]);
  return f && isFinite(v) ? Math.round(v * f) : null;
}

/** `wsl -l -q` を parse (pure)。 docker-desktop 系は除外。 */
export function parseDistroList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, "").replace(/^\*\s*/, "").trim())
    .filter((l) => l.length > 0 && !/^docker-desktop/i.test(l));
}

/** /proc/meminfo → {total, used} バイト (pure)。 */
export function parseMeminfo(raw: string): { total: number; used: number } | null {
  const get = (k: string): number | null => {
    const m = raw.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = get("MemTotal");
  const avail = get("MemAvailable");
  if (total == null || avail == null) return null;
  return { total, used: Math.max(0, total - avail) };
}

/** tasklist CSV から vmmem 系の合計 WorkingSet バイト (pure)。 */
export function parseVmmem(rawCsv: string): number {
  let bytes = 0;
  for (const line of rawCsv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split('","').map((x) => x.replace(/^"|"$/g, ""));
    if (!/^vmmem/i.test(f[0] ?? "")) continue;
    const kb = Number((f[f.length - 1] ?? "").replace(/[^0-9]/g, ""));
    if (Number.isFinite(kb)) bytes += kb * 1024;
  }
  return bytes;
}

/** docker stats NDJSON を parse (pure)。 */
export function parseDockerStats(raw: string): DockerSample[] {
  const out: DockerSample[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, string>;
      const used = parseSize((o.MemUsage ?? "").split("/")[0]?.trim() ?? "");
      const pm = (o.MemPerc ?? "").trim().match(/^([0-9.]+)%$/);
      out.push({
        name: (o.Name ?? "").replace(/^\//, "").trim(),
        rss: used ?? 0,
        percent: pm ? Number(pm[1]) : null,
      });
    } catch { /* skip */ }
  }
  return out;
}

export async function sampleWsl(): Promise<WslSample[]> {
  if (process.platform !== "win32") return [];
  const samples: WslSample[] = [];
  const listed = await runWsl(["-l", "-q"]);
  for (const distro of listed ? parseDistroList(listed) : []) {
    const mi = await runWsl(["-d", distro, "--", "cat", "/proc/meminfo"]);
    const parsed = mi ? parseMeminfo(mi) : null;
    if (parsed) samples.push({ key: distro, side: "guest", rss: parsed.used, total: parsed.total });
  }
  const tl = await runCapture("tasklist", ["/FO", "CSV", "/NH"], 8000);
  if (tl) {
    const vm = parseVmmem(tl);
    if (vm > 0) samples.push({ key: "vmmem", side: "host", rss: vm });
  }
  return samples;
}

export async function sampleDocker(): Promise<DockerSample[]> {
  const out = await runCapture("docker", ["stats", "--no-stream", "--format", "{{json .}}"], 15000);
  if (out == null) return [];
  return parseDockerStats(out)
    .filter((d) => d.name)
    .sort((a, b) => b.rss - a.rss);
}

function runWsl(args: string[]): Promise<string | null> {
  // wsl.exe の既定 UTF-16 出力を避けるため WSL_UTF8=1。 runCapture は env を渡せないので
  // 一時的にセットする (Concordia プロセス全体に影響するが WSL_UTF8 は無害)。
  const prev = process.env.WSL_UTF8;
  process.env.WSL_UTF8 = "1";
  return runCapture("wsl.exe", args, 8000).finally(() => {
    if (prev === undefined) delete process.env.WSL_UTF8;
    else process.env.WSL_UTF8 = prev;
  }) as Promise<string | null>;
}
