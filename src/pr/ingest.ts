/**
 * PR ingest watcher (取り込み方式 A — stat 派生).
 *
 * `stat.collected` を購読し、 その session の最新 stat payload から open_prs[] を
 * 抽出して pr_records へ UPSERT する. author = 報告した session (+ persona 名 snapshot).
 * エージェント側の追加作業ゼロで「誰がどの PR を open しているか」 が貯まる.
 *
 * 新規 PR を 1 件以上取り込んだら `pr.changed` を emit (Discord / WS 再描画トリガ).
 * 状態遷移 (merged/closed/ci/review) は reconcile.ts (方式 C) が確定する.
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { StatsRepo } from "../db/stats-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { parseOpenPrsFromStat } from "./normalize.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("pr-ingest");

export interface PrIngestDeps {
  sessions: SessionsRepo;
  stats: StatsRepo;
  personas: PersonasRepo;
  prs: PrRecordsRepo;
}

export interface PrIngestHandle {
  stop: () => void;
  /** テスト用: event を直接食わせる. */
  handle: (ev: ConcordiaEvent) => void;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function startPrIngestWatcher(deps: PrIngestDeps): PrIngestHandle {
  function resolvePersona(sessionId: string): { id: string | null; name: string | null } {
    const assignment = deps.personas.findActiveBySession(sessionId);
    if (!assignment) return { id: null, name: null };
    const p = deps.personas.find(assignment.persona_id);
    const name = p ? (p.display_name || p.name) : null;
    return { id: assignment.persona_id, name: name ?? null };
  }

  function handle(ev: ConcordiaEvent): void {
    if (ev.type !== "stat.collected") return;
    const session = deps.sessions.findSession(ev.session_id);
    if (!session) return;
    const latest = deps.stats.latest(ev.session_id);
    if (!latest) return;
    const prs = parseOpenPrsFromStat(safeParse(latest.payload));
    if (prs.length === 0) return;

    const persona = resolvePersona(ev.session_id);
    let inserted = 0;
    for (const pr of prs) {
      const existed = deps.prs.findByKey(pr.repo_origin, pr.number) !== null;
      deps.prs.upsertFromStat({
        repo_origin: pr.repo_origin,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        head_branch: pr.head_branch,
        repo_path: session.repo_path,
        author_session_id: session.id,
        persona_id: persona.id,
        persona_name: persona.name,
      });
      if (!existed) inserted += 1;
    }

    if (inserted > 0) {
      log.info(`ingested ${inserted} new PR(s) from session ${ev.session_id.slice(0, 8)}`);
      eventBus.emit({ type: "pr.changed", reason: "ingest", ts: Math.floor(Date.now() / 1000) });
    }
  }

  const unsub = eventBus.subscribe(handle);
  return { stop: () => unsub(), handle };
}
