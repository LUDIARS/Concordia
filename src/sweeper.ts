/**
 * Background sweeper.
 *
 * - active で last_seen_at が古い → status=lost + lost event 追加 + recovery を試みる
 * - lost で last_seen_at が更に古い → status=abandoned
 * - 古い session_events を auto-purge
 */

import { readFileSync, existsSync } from "node:fs";
import type { SessionsRepo } from "./db/sessions-repo.js";
import { getProvider } from "./providers/index.js";
import { createChildLogger } from "./shared/logger.js";

const log = createChildLogger("sweeper");

export interface SweeperOptions {
  repo: SessionsRepo;
  intervalMs: number;
  lostAfterSec: number;
  abandonedAfterSec: number;
  purgeAfterDays: number;
}

export function startSweeper(opts: SweeperOptions): { stop: () => void; runOnce: () => void } {
  let timer: NodeJS.Timeout | null = null;

  function tick(): void {
    try {
      runOnce();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "sweeper tick failed");
    }
  }

  function runOnce(): void {
    const now = Math.floor(Date.now() / 1000);

    // 1. active → lost
    const lostCutoff = now - opts.lostAfterSec;
    for (const s of opts.repo.findStaleActive(lostCutoff)) {
      opts.repo.setStatus(s.id, "lost", now);
      opts.repo.appendEvent({
        session_id: s.id,
        ts: now,
        kind: "lost",
        payload: { last_seen_at: s.last_seen_at },
      });
      const recovered = tryRecover(s.id, s.provider, s.repo_path, s.transcript_path);
      if (recovered) {
        opts.repo.appendEvent({
          session_id: s.id,
          ts: now,
          kind: "recovered",
          payload: recovered,
        });
      }
      log.info(
        { session_id: s.id, last_seen_at: s.last_seen_at, recovered: !!recovered },
        "session marked lost",
      );
    }

    // 2. lost → abandoned
    const abandonedCutoff = now - opts.abandonedAfterSec;
    const abandonedCount = opts.repo.abandonLost(abandonedCutoff);
    if (abandonedCount > 0) {
      log.info({ count: abandonedCount }, "lost sessions abandoned");
    }

    // 3. event purge
    const purgeCutoff = now - opts.purgeAfterDays * 86400;
    const purged = opts.repo.purgeEventsOlderThan(purgeCutoff);
    if (purged > 0) {
      log.info({ purged }, "old events purged");
    }
  }

  timer = setInterval(tick, opts.intervalMs);
  log.info({ intervalMs: opts.intervalMs }, "sweeper started");

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}

function tryRecover(
  sessionId: string,
  provider: string,
  cwd: string,
  transcriptPath: string | null,
): unknown | null {
  const p = getProvider(provider);
  if (!p) return null;
  const path = transcriptPath ?? p.transcriptPath(sessionId, cwd);
  if (!path || !existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8");
    return p.parseTranscript(content);
  } catch (err) {
    log.warn({ err: (err as Error).message, path }, "recovery failed");
    return null;
  }
}
