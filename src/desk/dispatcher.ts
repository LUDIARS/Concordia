/**
 * 依頼の起動・照合・終了観測 (spec/feature/request-desk.md、実装メモ 3)。
 * CDGD 管理の起動 (src/management/dispatcher.ts) と同じ作り: 起動前に spawn ID を保存し、
 * 結果不明は同じ ID で照合する。同じ依頼を別の ID で起動し直さない (CC-V5-INV-01)。
 *
 * @implements spec/feature/request-desk.md — 起動と照合
 */
import {
  DESK_LAUNCH_CONFIRM_WINDOW_MS,
  decideReconcile,
  shouldLaunch,
  type DeskRequest,
} from "./desk-request-policy.js";
import type { DeskRepository } from "./repository.js";

export type DeskLaunchResult = { ok: true } | { ok: false; error: string };

export interface DeskDispatchPorts {
  now: () => number;
  id: () => string;
  isEnabled: () => boolean;
  isCostBlocked: () => boolean;
  launch: (request: DeskRequest, spawnId: string) => Promise<DeskLaunchResult>;
  /** spawn ID で登録済みのセッションを引く。無ければ null。 */
  findSessionBySpawnId: (spawnId: string) => string | null;
  /** セッションが終わっているか。不明 (行が無い) は null。 */
  isSessionEnded: (sessionId: string) => boolean | null;
  /** 依頼の出来事 (Discord のスレッド・Web の詳細へ出す知らせ)。失敗しても遷移は戻さない。 */
  onChange?: (request: DeskRequest) => void;
  logError: (error: unknown) => void;
}

export class DeskDispatcher {
  private stopping = false;
  private active: Promise<void> | null = null;

  constructor(private readonly repo: DeskRepository, private readonly ports: DeskDispatchPorts) {}

  tick(): void {
    if (this.stopping) return;
    this.reconcileLaunches();
    this.observeFinished();
    const busy = this.active !== null;
    if (!shouldLaunch({ enabled: this.ports.isEnabled(), costBlocked: this.ports.isCostBlocked(), busy })) return;
    const next = this.repo.listByStates(["accepted"], 1)[0];
    if (!next) return;
    this.active = this.launchOne(next).catch(this.ports.logError).finally(() => { this.active = null; });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.active;
  }

  /** 走っている起動を待つ (テスト用)。 */
  async settle(): Promise<void> {
    await this.active;
  }

  reconcileLaunches(): void {
    for (const row of this.repo.listByStates(["launching", "launch_unknown"], 50)) {
      if (!row.spawn_id) continue;
      const decision = decideReconcile(row, this.ports.findSessionBySpawnId(row.spawn_id), this.ports.now());
      if (decision.kind === "running") this.changed(this.repo.transition(row, { state: "running", session_id: decision.sessionId, error: null }, this.ports.now()));
      if (decision.kind === "failed") this.changed(this.repo.transition(row, { state: "launch_failed", error: decision.reason }, this.ports.now()));
    }
  }

  observeFinished(): void {
    for (const row of this.repo.listByStates(["running"], 200)) {
      if (!row.session_id || this.ports.isSessionEnded(row.session_id) !== true) continue;
      this.changed(this.repo.transition(row, { state: "finished" }, this.ports.now()));
    }
  }

  private async launchOne(request: DeskRequest): Promise<void> {
    const spawnId = this.ports.id();
    const now = this.ports.now();
    // 起動前に spawn ID を保存する。CAS に負けたら他者が先に動かしたので何もしない。
    const launching = this.repo.transition(request, {
      state: "launching", spawn_id: spawnId, launch_deadline_at: now + DESK_LAUNCH_CONFIRM_WINDOW_MS, error: null,
    }, now);
    if (!launching) return;
    this.changed(launching);
    let result: DeskLaunchResult;
    try {
      result = await this.ports.launch(launching, spawnId);
    } catch (error) {
      // 例外は「起動したが応答を失った」場合を含む。失敗と決めず照合へ回す。
      this.ports.logError(error);
      this.changed(this.repo.transition(launching, { state: "launch_unknown", error: "起動の結果が不明です。spawn ID で照合しています" }, this.ports.now()));
      return;
    }
    if (!result.ok) {
      const current = this.repo.find(launching.id);
      if (current?.state === "launching") this.changed(this.repo.transition(current, { state: "launch_failed", error: result.error }, this.ports.now()));
    }
  }

  private changed(request: DeskRequest | null): void {
    if (!request) return;
    try { this.ports.onChange?.(request); } catch (error) { this.ports.logError(error); }
  }
}
