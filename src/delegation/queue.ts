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
 * この判定はここでしか行わない。 claim (`DelegationRepo.claimNextQueuedRun`) の上限チェックも
 * ここで数えた値を受け取る (`activeCount`)。 DB 側で status を生に数えると死んだ run が枠を
 * 占有し続けるため。
 *
 * 除外しても run の status は書き換えない。 「本当に失敗したのか、 報告を怠っただけか」
 * を Concordia は判別できないので、 勝手に failed へ倒すと監査ログに嘘が残る。
 * キューを流すのに必要なのはスロット計上から外すことだけなので、 そこに留める。
 */

import type { DelegationRepo, DelegationRunRow } from "../db/delegation-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { randomUUID } from "node:crypto";
import { delegationQueueClaim, QUEUE_CLAIM_LEASE_MS } from "./lease.js";
import { emitDelegationRunChanged } from "./run-events.js";

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
  /** Producer process uses this to persist every invocation for a separate worker. */
  producerOnly?: () => boolean;
}

export class DelegationQueue {
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly owner = randomUUID();

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
    return this.deps.producerOnly?.() === true || this.maxConcurrency() > 0;
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
    if (this.deps.producerOnly?.()) return false;
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
    if (this.deps.producerOnly?.()) return;
    if (this.draining) return;
    this.draining = true;
    try {
      const max = this.maxConcurrency();
      // このパスで払い出した run は stale 除外を免除して数える (`countOccupiedSlots`)。
      const claimedHere = new Set<string>();
      while (true) {
        const run = this.deps.repo.claimNextQueuedRun({
          owner: this.owner,
          now: this.now,
          leaseMs: QUEUE_CLAIM_LEASE_MS,
          maxConcurrency: max,
          // 上限 0 (無制限) のとき claim 側は activeCount を見ないので、 数え直しの
          // クエリ自体を省く (backlog 全件を流す経路で 1 件ごとに全 active 行を
          // 読み直さない)。
          activeCount: max > 0 ? this.countOccupiedSlots(claimedHere) : 0,
        });
        if (!run) break;
        claimedHere.add(run.id);
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
      const updated = this.deps.repo.markRunSpawned(
        run.id,
        { status: "spawn_failed", spawn_pid: null, spawn_command: null, error },
        delegationQueueClaim(run),
      );
      emitDelegationRunChanged(updated);
      log.warn({ run_id: run.id, error }, "delegation queue: queued run spawn threw");
    }
  }

  /**
   * claim に渡す占有スロット数。 stale な run は数えないが、 `claimedHere` (この drain
   * パスで払い出した run) だけは stale 判定を免除して数える。
   *
   * 免除が要るのは TTL 起点が `created_at` だから。 6h 以上 queued のまま待った run は
   * claim した瞬間から 「紐付け待ちのまま TTL 超過」 に見え (子セッションはまだ無い)、
   * 1 本も計上されないまま backlog を一気に spawn してしまう。
   *
   * 母集合は `listActiveRuns` (launching/spawned/running) のままなので、 払い出した直後に
   * spawn_failed / completed へ倒れた run は同じ drain パスの中で枠を返す。 払い出し済みを
   * 無条件に 1 枠と数えると、 spawn 失敗が続く backlog が 1 drain あたり上限本ずつしか
   * 流れなくなる (executeQueuedRun は payload 欠損などを throw せず spawn_failed に倒す)。
   */
  private countOccupiedSlots(claimedHere: ReadonlySet<string>): number {
    const now = this.now;
    return this.deps.repo.listActiveRuns()
      .filter((run) => claimedHere.has(run.id) || !this.isStale(run, now))
      .length;
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
