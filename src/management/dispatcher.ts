import { LAUNCH_CONFIRM_WINDOW_MS, type ManagementRequest, type Mission } from "./domain.js";
import type { ManagementService } from "./service.js";

/**
 * 依頼の払い出し・起動照合・終了観測 (CC-MGMT-04)。
 * 起動前に spawn ID を保存し、 結果不明は同じ ID で照合する (CC-MGMT-INV-03)。
 */

export type LaunchResult = { ok: true } | { ok: false; error: string };

export interface DispatchPorts {
  now: () => number;
  id: () => string;
  isBlocked: () => boolean;
  launch: (request: ManagementRequest, mission: Mission, spawnId: string) => Promise<LaunchResult>;
  /** spawn ID で登録済みセッションを引く。 無ければ null。 */
  findSessionBySpawnId: (spawnId: string) => { id: string } | null;
  /** セッションが終わっているか。 不明 (行が無い) は null。 */
  isSessionEnded: (sessionId: string) => boolean | null;
  logError: (error: unknown) => void;
}

export class ManagementDispatcher {
  private stopping = false;
  private active: Promise<void> | null = null;

  constructor(private readonly service: ManagementService, private readonly ports: DispatchPorts) {}

  tick(): void {
    if (this.stopping) return;
    this.reconcileLaunches();
    this.observeFinished();
    if (this.active || this.ports.isBlocked()) return;
    const next = this.nextQueued();
    if (!next) return;
    this.active = this.launchOne(next.request, next.mission).catch(this.ports.logError).finally(() => {
      this.active = null;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.active;
  }

  /** launching / launch_unknown を spawn ID で照合する。 */
  reconcileLaunches(): void {
    const repo = this.service.repo;
    for (const row of repo.listRequestsByStates(["launching", "launch_unknown"], 50)) {
      if (!row.spawn_id) continue;
      const session = this.ports.findSessionBySpawnId(row.spawn_id);
      if (session) {
        const next = repo.transition(row, { state: "dispatched", session_id: session.id, error: null }, this.ports.now());
        if (next) this.service.appendLifecycle(next, "request_dispatched", `依頼 ${next.request_key} の担当セッション ${session.id} を確認しました`);
        continue;
      }
      if (row.launch_deadline_at !== null && this.ports.now() > row.launch_deadline_at) {
        const next = repo.transition(row, {
          state: "launch_failed",
          error: row.error ?? "起動期限内にセッション登録を確認できませんでした",
        }, this.ports.now());
        if (next) this.service.appendLifecycle(next, "request_launch_failed", `依頼 ${next.request_key} の起動を確認できませんでした`);
      }
    }
  }

  /** dispatched の担当セッションが終わったら execution_finished。 */
  observeFinished(): void {
    const repo = this.service.repo;
    for (const row of repo.listRequestsByStates(["dispatched"], 100)) {
      if (!row.session_id || this.ports.isSessionEnded(row.session_id) !== true) continue;
      const next = repo.transition(row, { state: "execution_finished" }, this.ports.now());
      if (next) this.service.appendLifecycle(next, "request_execution_finished", `依頼 ${next.request_key} の担当セッションが終了しました (成果は未確認)`);
    }
  }

  private nextQueued(): { request: ManagementRequest; mission: Mission } | null {
    const repo = this.service.repo;
    for (const request of repo.listRequestsByStates(["queued"], 20)) {
      const mission = repo.findMission(request.mission_id);
      // 停止中の任務の依頼は払い出さず保持する (CC-MGMT-INV-05)。
      if (mission?.status === "active") return { request, mission };
    }
    return null;
  }

  private async launchOne(request: ManagementRequest, mission: Mission): Promise<void> {
    const repo = this.service.repo;
    const spawnId = this.ports.id();
    const now = this.ports.now();
    // 起動前に spawn ID を保存する。 CAS に負けたら他者が先に動かしたので何もしない。
    const launching = repo.transition(request, {
      state: "launching", spawn_id: spawnId, launch_deadline_at: now + LAUNCH_CONFIRM_WINDOW_MS, error: null,
    }, now);
    if (!launching) return;
    let result: LaunchResult;
    try {
      result = await this.ports.launch(launching, mission, spawnId);
    } catch (error) {
      // 例外は「起動したが応答を失った」場合を含む。 失敗と決めず照合へ回す。
      this.ports.logError(error);
      const unknown = repo.transition(launching, { state: "launch_unknown", error: "起動の結果が不明です。spawn ID で照合しています" }, this.ports.now());
      if (unknown) this.service.appendLifecycle(unknown, "request_launch_unknown", `依頼 ${unknown.request_key} の起動結果が不明です`);
      return;
    }
    if (!result.ok) {
      const failed = repo.transition(launching, { state: "launch_failed", error: result.error }, this.ports.now());
      if (failed) this.service.appendLifecycle(failed, "request_launch_failed", `依頼 ${failed.request_key} の起動に失敗しました`);
      return;
    }
    this.service.appendLifecycle(launching, "request_launching", `依頼 ${launching.request_key} のセッションを起動しました (登録待ち)`);
  }
}
