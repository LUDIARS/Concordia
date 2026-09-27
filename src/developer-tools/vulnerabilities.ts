// @spec CC-TOOLS-02: 連携と準備
// @spec CC-TOOLS-03: 変更と検証
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { boundedJson } from "./service-http.js";
import { unavailable } from "./contracts.js";

const Lock = z.object({ lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(z.object({ name: z.string().optional(), version: z.string().optional(),
    link: z.boolean().optional(), resolved: z.string().optional() })) });

export function lockedPackages(lock: unknown): { name: string; version: string }[] {
  const parsed = Lock.safeParse(lock);
  if (!parsed.success) unavailable("unsupported_lockfile", "npm package-lock v2/v3 を用意してください。未対応形式は未検証です。");
  const packages = new Map<string, { name: string; version: string }>();
  for (const [path, entry] of Object.entries(parsed.data.packages)) {
    if (!path.includes("node_modules/") || entry.link) continue;
    if (entry.resolved && !/^https:\/\//.test(entry.resolved)) continue;
    const name = entry.name ?? path.split("node_modules/").at(-1);
    if (!name || !entry.version || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(entry.version)) {
      unavailable("unresolved_dependency", "固定バージョンに解決できない依存があります。対象 lockfile を確認してください。");
    }
    packages.set(`${name}@${entry.version}`, { name, version: entry.version });
  }
  if (packages.size === 0 || packages.size > 10_000) unavailable("dependency_count_unsupported", "依存が空、または照会上限を超えています。lockfile を確認してください。");
  return [...packages.values()];
}

export async function checkVulnerabilities(cwd: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const path = join(cwd, "package-lock.json");
  const info = await stat(path).catch(() => null);
  if (!info || info.size > 20 * 1024 * 1024) unavailable("lockfile_required", "20 MB 以下の npm package-lock v2/v3 が必要です。");
  const lock: unknown = JSON.parse(await readFile(path, "utf8"));
  const packages = lockedPackages(lock);
  const excluded = Object.entries(Lock.parse(lock).packages).filter(([path, entry]) =>
    path.includes("node_modules/") && (entry.link || entry.resolved && !/^https:\/\//.test(entry.resolved)))
    .map(([path]) => ({ package: path.split("node_modules/").at(-1), reason: "local_or_non_registry_dependency" }));
  const findings: { package: string; version: string; ids: string[] }[] = [];
  for (let start = 0; start < packages.length; start += 500) {
    let batch: { name: string; version: string; token?: string }[] = packages.slice(start, start + 500);
    for (let page = 0; batch.length; page++) {
      if (page >= 20) unavailable("vulnerability_result_incomplete", "OSV のページ上限に達しました。部分結果を合格として扱わず再確認してください。");
      const response = await fetchImpl("https://api.osv.dev/v1/querybatch", { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: batch.map(item => ({ package: { name: item.name, ecosystem: "npm" }, version: item.version,
          ...(item.token ? { page_token: item.token } : {}) })) }) });
      if (!response.ok) { await response.body?.cancel(); unavailable("vulnerability_database_unavailable", "OSV 接続を確認してください。依存の安全性は未検証です。"); }
      const result = z.object({ results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).optional(), next_page_token: z.string().optional() })) })
        .parse(await boundedJson(response));
      if (result.results.length !== batch.length) throw new Error("incomplete vulnerability response");
      const next: typeof batch = [];
      result.results.forEach((entry, index) => {
        const item = batch[index]!;
        if (entry.vulns?.length) findings.push({ package: item.name, version: item.version, ids: entry.vulns.map(vulnerability => vulnerability.id) });
        if (entry.next_page_token) next.push({ ...item, token: entry.next_page_token });
      });
      batch = next;
    }
  }
  return { checked: packages.length, source: "OSV", scope: "npm locked dependencies; source-code security review is separate",
    passed: excluded.length ? null : findings.length === 0, registry_dependencies_passed: findings.length === 0,
    coverage: excluded.length ? "partial" : "complete", excluded, findings };
}
