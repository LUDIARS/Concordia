/**
 * 自動コンパクション。 active セッションのコンテキスト占有と「区切り」を周期監視し、
 * 条件成立で runCompaction を発火する。 安全弁 env CONCORDIA_AUTO_COMPACTION=1 (既定 OFF)。
 *
 * spec/feature/session-compaction.md §5。 判定は純粋関数 shouldAutoCompact に集約。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { estimateContextTokens } from "../cost/context-estimate.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("auto-compaction");

export interface AutoCompactionOpts {
  /** これを超えたら区切り無しでも圧縮 (hard)。 */
  autoThreshold: number;
  /** 区切りがあるとき圧縮に踏み切る下限 (soft)。 */
  softThreshold: number;
  /** 直近コンパクションからこの秒数未満は抑止。 */
  cooldownSec: number;
  /** 直近アクティビティからこの秒数未満は「作業中」とみなし見送る。 */
  activeQuietSec: number;
}

export const DEFAULT_AUTO_COMPACTION_OPTS: AutoCompactionOpts = {
  autoThreshold: Number(process.env.CONCORDIA_COMPACTION_AUTO_PCT ?? "0.75") || 0.75,
  softThreshold: Number(process.env.CONCORDIA_COMPACTION_SOFT_PCT ?? "0.55") || 0.55,
  cooldownSec: Number(process.env.CONCORDIA_COMPACTION_COOLDOWN_SEC ?? "1800") || 1800,
  activeQuietSec: Number(process.env.CONCORDIA_COMPACTION_QUIET_SEC ?? "90") || 90,
};

export interface AutoCompactionInput {
  contextPct: number | null;
  lastCompactionAt: number | null;
  lastActivityAt: number | null;
  /** 直近に「タスク完了/PR merged」等の区切りがあったか。 */
  recentBreakpoint: boolean;
  now: number;
  opts: AutoCompactionOpts;
}

export type AutoCompactionDecision =
  | { compact: false; reason: string }
  | { compact: true; reason: "threshold" | "breakpoint" };

/** 自動コンパクションすべきかの純粋判定。 */
export function shouldAutoCompact(input: AutoCompactionInput): AutoCompactionDecision {
  const { contextPct, lastCompactionAt, lastActivityAt, recentBreakpoint, now, opts } = input;
  if (contextPct === null) return { compact: false, reason: "context unknown" };
  // クールダウン中は抑止。
  if (lastCompactionAt !== null && now - lastCompactionAt < opts.cooldownSec * 1000) {
    return { compact: false, reason: "cooldown" };
  }
  // 直近アクティビティが活発 = 対話/作業中。 ぶつ切りにしない。
  if (lastActivityAt !== null && now - lastActivityAt < opts.activeQuietSec * 1000) {
    return { compact: false, reason: "active" };
  }
  // hard 閾値: 区切り不問で圧縮。
  if (contextPct >= opts.autoThreshold) return { compact: true, reason: "threshold" };
  // 区切り + soft 閾値: 切りの良いところで圧縮。
  if (recentBreakpoint && contextPct >= opts.softThreshold) return { compact: true, reason: "breakpoint" };
  return { compact: false, reason: "below threshold" };
}

export interface AutoCompactionDeps {
  sessions: SessionsRepo;
  /** 1 セッションを圧縮する (control/compaction.runCompaction を bind したもの)。 */
  compact: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  /** 直近の区切り (PR merged / タスク完了) を検出する。 既定は false。 */
  detectBreakpoint?: (sessionId: string) => boolean;
  enabled: () => boolean;
  intervalMs?: number;
  opts?: AutoCompactionOpts;
}

export interface AutoCompactionHandle {
  stop(): void;
  /** 1 周分の評価を即実行する (テスト/手動)。 圧縮した session id を返す。 */
  runOnce(now?: number): Promise<string[]>;
}

export function startAutoCompaction(deps: AutoCompactionDeps): AutoCompactionHandle {
  const opts = deps.opts ?? DEFAULT_AUTO_COMPACTION_OPTS;
  const intervalMs = deps.intervalMs ?? 5 * 60 * 1000;

  async function runOnce(now = Date.now()): Promise<string[]> {
    if (!deps.enabled()) return [];
    const compacted: string[] = [];
    for (const s of deps.sessions.findAllActive()) {
      const est = await estimateContextTokens(s);
      const meta = readMeta(s.metadata);
      const decision = shouldAutoCompact({
        contextPct: est?.pct ?? null,
        lastCompactionAt: typeof meta.last_compaction_at === "number" ? meta.last_compaction_at : null,
        lastActivityAt: s.last_seen_at ? s.last_seen_at * 1000 : null,
        recentBreakpoint: deps.detectBreakpoint?.(s.id) ?? false,
        now,
        opts,
      });
      if (!decision.compact) continue;
      log.info(`auto-compaction: firing session=${s.id} reason=${decision.reason} pct=${est?.pct?.toFixed(2)}`);
      try {
        const r = await deps.compact(s.id);
        if (r.ok) compacted.push(s.id);
        else log.warn(`auto-compaction: compact failed session=${s.id}: ${r.error}`);
      } catch (e) {
        log.warn(`auto-compaction: compact threw session=${s.id}: ${(e as Error).message}`);
      }
    }
    return compacted;
  }

  const supervised = startSupervisedInterval("auto-compaction", async () => { await runOnce(); }, {
    intervalMs,
    log: { warn: (message) => log.warn(message) },
  });

  return {
    stop: supervised.stop,
    runOnce,
  };
}

function readMeta(s: string | null): { last_compaction_at?: number } {
  if (!s) return {};
  try {
    return JSON.parse(s) as { last_compaction_at?: number };
  } catch {
    return {};
  }
}
