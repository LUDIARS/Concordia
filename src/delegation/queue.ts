/**
 * Delegation 実行キュー。 同時実行数に上限を設け、 超えた invoke は spawn せず
 * `status='queued'` で待たせ、 スロットが空き次第 FIFO で起動する。
 *
 * spec/feature/delegation-coordination.md §6。
 *
 * ## スロットの数え方 (stale 扱い)
 * 委託先の子は完了時に `POST /v1/delegation/runs/:id/status` を返す作法だが、 これを
 * 返さずに死ぬことがある (プロセス強制終了・CLI クラッシュ)。 その run は永久に
 * `running` のまま残るため、 素朴に status だけでスロットを数えるとキューが二度と
 * 流れなくなる。 そこで active カウントからは次を除外する (= スロットを解放する):
 *
 *   - 子セッションが紐付いていて、 そのセッションが既に active でない
 *   - 紐付いた子セッションが無いまま TTL (既定 6h) を超えた
 *
 * 除外しても run の status は書き換えない。 「本当に失敗したのか、 報告を怠っただけか」
 * を Concordia は判別できないので、 勝手に failed へ倒すと監査ログに嘘が残る。
 * キューを流すのに必要なのはスロット計上から外すことだけなので、 そこに留める。
 */

import type { DelegationRepo, DelegationRunRow } from "../db/delegation-repo.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("delegation/queue");

/** 同時実行上限の既定値。 0 = 無制限 (キュー無効)。 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** 子セッション未紐付けのまま この時間を超えた run はスロット計上から外す。 */
export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

/** 定期 drain の間隔 (status 報告漏れ / 取りこぼしの保険)。 */
const TICK_MS = 20_000;

export interface DelegationQueueDeps {
  repo: DelegationRepo;
  /** 子セッションが生きているかの判定に使う (status='active' のみ生存扱い)。 */
  sessions: { findSession: (id: string) => { status: string } | null };
  /** 同時実行上限を live 解決する (AdminState 由来。 0 = 無制限)。 */
  resolveMaxConcurrency: () => number;
  /** queued run を実際に spawn する (DelegationService が注入)。 */
  spawnQueued: (run: DelegationRunRow) => Promise<void>;
  staleMs?: number;
  now?: () => number;
}

export class DelegationQueue {
  private draining = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DelegationQueueDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get staleMs(): number {
    return this.deps.staleMs ?? DEFAULT_STALE_MS;
  }

  maxConcurrency(): number {
    const n = this.deps.resolveMaxConcurrency();
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** 上限が 0 (無制限) ならキューは働かない。 */
  enabled(): boolean {
    return this.maxConcurrency() > 0;
  }

  /** スロットを占有している run (stale を除く)。 */
  activeRuns(): DelegationRunRow[] {
    const now = this.now;
    return this.deps.repo.listActiveRuns().filter((run) => !this.isStale(run, now));
  }

  activeCount(): number {
    return this.activeRuns().length;
  }

  /** 今すぐ spawn してよいか (= 空きスロットがあるか)。 */
  hasCapacity(): boolean {
    const max = this.maxConcurrency();
    if (max === 0) return true;
    return this.activeCount() < max;
  }

  /** queued run の待ち順 (1 始まり)。 queued でなければ null。 */
  position(runId: string): number | null {
    const queued = this.deps.repo.listQueuedRuns();
    const idx = queued.findIndex((r) => r.id === runId);
    return idx < 0 ? null : idx + 1;
  }

  queuedCount(): number {
    return this.deps.repo.listQueuedRuns().length;
  }

  /** 空きスロットの分だけ queued run を FIFO で起動する。 多重呼び出しは 1 本に畳む。 */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const max = this.maxConcurrency();
      if (max === 0) {
        // 上限が外された (0 に変更された) なら待たせている分は全部流す。
        for (const run of this.deps.repo.listQueuedRuns()) await this.spawn(run);
        return;
      }
      for (const run of this.deps.repo.listQueuedRuns()) {
        if (this.activeCount() >= max) break;
        await this.spawn(run);
      }
    } finally {
      this.draining = false;
    }
  }

  /** 定期 drain を開始する (プロセス終了は妨げない)。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain().catch((e) => log.warn({ err: (e as Error).message }, "queue drain tick failed"));
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async spawn(run: DelegationRunRow): Promise<void> {
    log.info({ run_id: run.id, call_name: run.call_name }, "delegation queue: spawning queued run");
    try {
      await this.deps.spawnQueued(run);
    } catch (e) {
      // spawn 経路の想定外例外。 queued のまま残すと同じ run で無限に再試行するので
      // spawn_failed に倒して payload を落とす (再実行は新しい invoke で行う)。
      const error = (e as Error).message;
      this.deps.repo.markRunSpawned(run.id, { status: "spawn_failed", spawn_pid: null, spawn_command: null, error });
      log.warn({ run_id: run.id, error }, "delegation queue: queued run spawn threw");
    }
  }

  /**
   * その run がもうスロットを占有していないとみなせるか。
   * 子セッションが終了済み / 紐付かないまま TTL 超過 の 2 パターン。
   */
  private isStale(run: DelegationRunRow, now: number): boolean {
    if (run.child_session_id) {
      const session = this.deps.sessions.findSession(run.child_session_id);
      return !session || session.status !== "active";
    }
    return now - run.created_at > this.staleMs;
  }
}
