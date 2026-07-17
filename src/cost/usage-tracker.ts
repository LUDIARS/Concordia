/**
 * CostUsageTracker — 日次トークン消費を蓄積し、 予算超過を判定する。
 *
 * sample() を定期 tick で呼ぶと、 最近更新された全ログファイル (登録外の
 * 外部バッチ含む) の累積トークンを読み、 前回観測値との差分 (delta) を
 * 当日バケットに足し込む。 status() は当日累積と予算から block 判定を返す。
 *
 * 初回観測のファイルは baseline を記録するだけで当日に加算しない (起動直後に
 * 既存ログの全累積を「今日の消費」 と誤計上しないため)。
 */

import type { CostBudgetRepo } from "./cost-budget-repo.js";
import { enumerateRecentLogTotals } from "./log-usage.js";

/** mtime がこの窓内のログのみ走査する (これより古いファイルは増えない前提)。 */
const LOG_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export interface CostBudgetStatus {
  /** 当日 (local) の累積消費トークン。 */
  todayTokens: number;
  /** 設定中の日次予算 (トークン)。 0 = 無効。 */
  budget: number;
  /** 予算超過でブロック中か (budget>0 かつ todayTokens>=budget)。 */
  blocked: boolean;
  /** 当日の日付 (local "YYYY-MM-DD")。 */
  dateIso: string;
}

export interface CostUsageTrackerDeps {
  repo: CostBudgetRepo;
  /** 日次予算トークン (0 = 無効)。 毎回 live 取得 (AdminState 由来)。 */
  getBudget: () => number;
  /** 時刻プロバイダ (テスト差し替え用)。 既定 Date.now。 */
  now?: () => number;
  /** ログ列挙関数 (テスト差し替え用)。 既定 enumerateRecentLogTotals。 */
  enumerate?: (maxAgeMs: number, now: number) => Promise<Array<{ path: string; total: number }>>;
}

export class CostUsageTracker {
  private readonly now: () => number;
  private readonly enumerate: (maxAgeMs: number, now: number) => Promise<Array<{ path: string; total: number }>>;

  constructor(private readonly deps: CostUsageTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.enumerate = deps.enumerate ?? enumerateRecentLogTotals;
  }

  /** 最近のログを走査し、 増分を当日バケットへ加算する (tick から呼ぶ)。 */
  async sample(): Promise<void> {
    const now = this.now();
    const dateIso = localDateIso(now);
    const files = await this.enumerate(LOG_WINDOW_MS, now);
    for (const f of files) {
      const last = this.deps.repo.getLogLastTotal(f.path);
      if (last === null) {
        // 初回観測 — baseline だけ記録 (当日へは足さない)。
        this.deps.repo.setLogLastTotal(f.path, f.total, now);
        continue;
      }
      const delta = f.total - last;
      if (delta > 0) {
        this.deps.repo.addDayTokens(dateIso, delta, now);
        this.deps.repo.setLogLastTotal(f.path, f.total, now);
      }
    }
    // 監視窓を超えた baseline は掃除 (ファイルはもう増えない)。
    this.deps.repo.pruneLogSeen(now - LOG_WINDOW_MS);
  }

  /** 当日の消費 / 予算 / block 判定を返す (cheap、 enforcement 経路から毎回呼ぶ)。 */
  status(): CostBudgetStatus {
    const now = this.now();
    const dateIso = localDateIso(now);
    const budget = Math.max(0, Math.floor(this.deps.getBudget() || 0));
    const todayTokens = this.deps.repo.getDayTokens(dateIso);
    return {
      todayTokens,
      budget,
      blocked: budget > 0 && todayTokens >= budget,
      dateIso,
    };
  }

  /** 予算超過でブロック中か (enforcement 用ショートカット)。 */
  isBlocked(): boolean {
    return this.status().blocked;
  }
}

/** epoch(ms) → local "YYYY-MM-DD"。 */
export function localDateIso(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
