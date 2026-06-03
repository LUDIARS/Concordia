/**
 * PR full-sync tick (取り込み方式 D — org 全体の open PR を発見).
 *
 * ingest.ts (方式 A) は session が /v1/stat で報告した PR しか拾えず、 reconcile.ts
 * (方式 C) は既存行の状態確定しかしない。 そのため「誰も報告していない open PR」は
 * pr_records に載らず PR Queue に出てこなかった。 ここでは `gh search prs` で **org の
 * open PR をすべて**発見し、 未登録のものを pr_records に挿入する (state/ci/review の
 * 確定は reconcile に委ねる)。
 *
 * - 無効化: env CONCORDIA_PR_FULL_SYNC_ENABLED=0
 * - org:    env CONCORDIA_PR_SYNC_OWNER (既定 LUDIARS)
 * - 間隔:   env CONCORDIA_PR_FULL_SYNC_MIN (分, 既定 15, 下限 2)
 * - 上限:   env CONCORDIA_PR_FULL_SYNC_LIMIT (既定 300)
 * - gh 無し / 認証切れは best-effort (warn のみ、 サービスは落とさない)。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import { isOwnerRepo, prUrlFor } from "./normalize.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const execFileAsync = promisify(execFile);
const log = createChildLogger("pr-full-sync");
const GH_BIN = process.platform === "win32" ? "gh.exe" : "gh";

export interface SearchedPr {
  repo_origin: string;
  number: number;
  title: string;
  url: string | null;
  isDraft: boolean;
}

/**
 * `gh search prs --json number,title,url,repository,isDraft` の stdout を parse する.
 * repository は { nameWithOwner } を持つ。 owner/repo 形式でない / number 欠落は捨てる.
 * (pure 関数 — テスト容易性のため I/O から分離)
 */
export function parseSearchPrs(stdout: string): SearchedPr[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: SearchedPr[] = [];
  for (const raw of parsed as Array<Record<string, unknown>>) {
    const repo = raw?.repository as { nameWithOwner?: string; name?: string } | undefined;
    const origin = repo?.nameWithOwner ?? repo?.name ?? null;
    const number = typeof raw?.number === "number" ? raw.number : null;
    if (!origin || !isOwnerRepo(origin) || number == null) continue;
    out.push({
      repo_origin: origin,
      number,
      title: typeof raw.title === "string" ? raw.title : "",
      url: typeof raw.url === "string" ? raw.url : null,
      isDraft: raw.isDraft === true,
    });
  }
  return out;
}

export interface PrFullSyncDeps {
  prs: PrRecordsRepo;
}

export interface PrFullSyncHandle {
  stop: () => void;
  /** テスト/手動用: 1 回だけ走らせる. */
  runOnce: () => Promise<{ found: number; inserted: number }>;
}

export function startPrFullSync(deps: PrFullSyncDeps): PrFullSyncHandle {
  const enabled = process.env.CONCORDIA_PR_FULL_SYNC_ENABLED !== "0";
  const owner = (process.env.CONCORDIA_PR_SYNC_OWNER ?? "LUDIARS").trim();
  const minutes = Math.max(2, Number(process.env.CONCORDIA_PR_FULL_SYNC_MIN ?? "15") || 15);
  const limit = Math.max(1, Math.min(1000, Number(process.env.CONCORDIA_PR_FULL_SYNC_LIMIT ?? "300") || 300));

  async function runOnce(): Promise<{ found: number; inserted: number }> {
    if (!enabled || !owner) return { found: 0, inserted: 0 };
    let stdout: string;
    try {
      const r = await execFileAsync(
        GH_BIN,
        [
          "search", "prs",
          "--owner", owner,
          "--state", "open",
          "--limit", String(limit),
          "--json", "number,title,url,repository,isDraft",
        ],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      stdout = r.stdout;
    } catch (e) {
      log.warn(`gh search prs failed for owner=${owner}: ${(e as Error).message}`);
      return { found: 0, inserted: 0 };
    }
    const prs = parseSearchPrs(stdout);
    let inserted = 0;
    for (const p of prs) {
      if (deps.prs.findByKey(p.repo_origin, p.number)) continue;
      // 未登録の open PR を発見 → 最小情報で挿入 (state/ci/review は reconcile が確定)。
      deps.prs.upsertFromStat({
        repo_origin: p.repo_origin,
        number: p.number,
        title: p.title,
        url: p.url ?? prUrlFor(p.repo_origin, p.number),
        author_session_id: null,
      });
      inserted += 1;
    }
    if (inserted > 0) {
      eventBus.emit({ type: "pr.changed", reason: "full-sync", ts: Math.floor(Date.now() / 1000) });
    }
    return { found: prs.length, inserted };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (enabled) {
    const kick = setTimeout(() => {
      void runOnce()
        .then((r) => log.info(`full-sync: found=${r.found} inserted=${r.inserted}`))
        .catch((e) => log.warn(`full-sync run failed: ${(e as Error).message}`));
    }, 20_000);
    kick.unref?.();
    timer = setInterval(() => {
      void runOnce()
        .then((r) => log.info(`full-sync: found=${r.found} inserted=${r.inserted}`))
        .catch((e) => log.warn(`full-sync run failed: ${(e as Error).message}`));
    }, minutes * 60 * 1000);
    timer.unref?.();
  } else {
    log.info("CONCORDIA_PR_FULL_SYNC_ENABLED=0; full-sync disabled");
  }

  return {
    stop: () => { if (timer) clearInterval(timer); },
    runOnce,
  };
}
