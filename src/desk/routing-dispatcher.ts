import type { TaskDocument } from "../taskflow/types.js";
import { DESK_LAUNCH_CONFIRM_WINDOW_MS, type DeskRequest } from "./desk-request-policy.js";
import type { DeskLaunchResult } from "./dispatcher.js";
import type { DeskDelegationRun } from "./project-control-delegation.js";
import type { DeskRepository, DeskRequestPatch } from "./repository.js";
import { canOfferDeskRequest, resolveDeskProject, type DeskProject, type ProjectControlSession } from "./routing-policy.js";

const WAIT_MS = 10_000;
const POLL_MS = 60_000;
const MAX_PENDING_LAUNCHES = 4;
const DELEGATION_UNCONFIRMED = "委託の受付を照合しています。既存の run を確認してください。";

export interface DeskRoutingPorts {
  now(): number;
  id(): string;
  isCostBlocked(): boolean;
  projects(): DeskProject[];
  createTask(request: DeskRequest, repoPath: string): Promise<TaskDocument>;
  readTask(repoPath: string, reference: string): Promise<TaskDocument>;
  assign(repoPath: string, reference: string, sessionId: string | null, expected: string | null): Promise<void>;
  projectControl(project: DeskProject): ProjectControlSession | null;
  isProjectControl(sessionId: string): boolean;
  delegationRun(requestId: string): DeskDelegationRun | null;
  delegate(request: DeskRequest, project: DeskProject, retry: boolean): Promise<boolean>;
  launch(request: DeskRequest, project: DeskProject, spawnId: string): Promise<DeskLaunchResult>;
  findSessionBySpawnId(spawnId: string): string | null;
  hasResidentCapacity(projectCode: string): boolean;
  canDeliver(sessionId: string, requestId: string, reference: string): boolean;
  deliver(sessionId: string, requestId: string, reference: string): void;
  onChange(request: DeskRequest): void;
  logError(error: unknown): void;
}

export class DeskRoutingDispatcher {
  private active: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly repo: DeskRepository, private readonly ports: DeskRoutingPorts) {}

  tick(): void {
    if (this.stopping || this.active) return;
    const request = this.repo.dueForRouting(this.ports.now());
    if (!request) return;
    this.active = this.route(request).catch((error: unknown) => {
      this.ports.logError(error);
      const current = this.repo.find(request.id);
      if (current) this.update(current, { error: current.routing_issue || current.error === DELEGATION_UNCONFIRMED
        ? current.error : "Actio または配信先を確認できません。表示中の依頼を再照合します。",
        retry_at: this.ports.now() + POLL_MS });
    }).finally(() => { this.active = null; });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.active;
  }

  async settle(): Promise<void> {
    await this.active;
  }

  private async route(request: DeskRequest): Promise<void> {
    const projects = this.ports.projects();
    const project = request.project_code
      ? projects.find(({ code }) => code === request.project_code)
      : resolveDeskProject(request.body, projects, request.requested_project);
    if (!project || (request.routing_repo && request.routing_repo !== project.repoPath)) {
      this.update(request, { routing_issue: request.task_reference || request.routing_repo ? "delivery" : "project",
        error: request.routing_repo ? "登録済みプロジェクトが変わりました。元の登録を確認してください。" : "依頼の対象プロジェクトを選ぶ" });
      return;
    }
    const current = request.routing_repo ? request : this.update(request, { project_code: project.code, routing_repo: project.repoPath });
    if (!current) return;
    if (current.state === "launching" || current.state === "launch_unknown") {
      this.confirmLaunch(current, project);
      return;
    }
    const task = current.task_reference
      ? await this.ports.readTask(project.repoPath, current.task_reference)
      : await this.ports.createTask(current, project.repoPath);
    const routed = current.task_reference ? current : this.update(current, { task_reference: task.path, error: null });
    if (!routed || this.stopping) return;
    if (task.runtime?.status === "done" || task.runtime?.status === "cancelled") {
      this.update(routed, { state: "finished", routing_issue: null, error: null });
      return;
    }
    const worker = typeof task.frontmatter.working_session_id === "string" ? task.frontmatter.working_session_id : null;
    if (routed.state === "running") await this.observeAssignment(routed, project, task, worker);
    else await this.assignOrLaunch(routed, project);
  }

  private confirmLaunch(request: DeskRequest, project: DeskProject): void {
    if (this.ports.projectControl(project)?.spawnId === request.spawn_id) {
      this.update(request, { state: "accepted", error: null, retry_at: 0 });
    } else if ((request.launch_deadline_at ?? 0) <= this.ports.now()) {
      this.launchFailed(request, this.ports.findSessionBySpawnId(request.spawn_id ?? "")
        ? "登録されたプロジェクト管制に接続できませんでした" : "プロジェクト管制の登録を確認できませんでした");
    } else this.defer(request);
  }

  private async assignOrLaunch(request: DeskRequest, project: DeskProject): Promise<void> {
    if (this.ports.isCostBlocked()) { this.defer(request); return; }
    const selected = this.ports.projectControl(project);
    if (selected) {
      this.update(request, { state: "running", session_id: selected.id, delivery: "waiting", error: null, retry_at: 0 });
      return;
    }
    const spawnId = this.ports.id();
    const launching = this.repo.transaction(() => {
      const pending = this.repo.pendingLaunches(project.code);
      const last = this.repo.projectLaunch(project.code);
      if (pending.forProject || pending.total >= MAX_PENDING_LAUNCHES || !this.ports.hasResidentCapacity(project.code)
        || last?.state === "launch_failed") return null;
      return this.repo.transition(request, { state: "launching", spawn_id: spawnId,
        launch_deadline_at: Math.max(this.ports.now() + DESK_LAUNCH_CONFIRM_WINDOW_MS, (last?.launch_deadline_at ?? 0) + 1),
        error: null }, this.ports.now());
    });
    if (!launching) { this.defer(request); return; }
    try {
      this.notifyChange(launching);
      const result = await this.ports.launch(launching, project, spawnId);
      if (!result.ok) this.launchFailed(launching, result.error);
      else this.defer(launching);
    } catch (error) {
      this.ports.logError(error);
      this.update(launching, { state: "launch_unknown", error: "登録を起動 ID で照合しています" });
    }
  }

  private async observeAssignment(request: DeskRequest, project: DeskProject, task: TaskDocument, worker: string | null): Promise<void> {
    const sessionId = request.session_id;
    if (!sessionId) return;
    const controller = this.ports.projectControl(project);
    const run = this.ports.delegationRun(request.id);
    if (request.delivery === "claimed" && !run && !this.ports.isProjectControl(sessionId)) {
      this.deliveryIssue(request, "旧方式で着手済みの依頼です。作業結果を確認してください。");
      return;
    }
    if (request.delivery === "claimed" && request.error === DELEGATION_UNCONFIRMED && !run) {
      this.deliveryIssue(request, DELEGATION_UNCONFIRMED);
      return;
    }
    let assignedWorker = worker;
    if (assignedWorker !== null && assignedWorker !== run?.childSessionId) {
      const belongsToDesk = assignedWorker === sessionId || assignedWorker === request.previous_session_id;
      if (!belongsToDesk || (task.runtime?.status !== "pending" && run === null)) {
        this.deliveryIssue(request, "Actio の担当と既存の作業結果を確認してください。");
        return;
      }
      if (assignedWorker !== controller?.id) {
        await this.ports.assign(project.repoPath, task.path, null, assignedWorker);
        assignedWorker = null;
      }
    }
    if (controller?.id !== sessionId) {
      if (!run && request.delivery === "claimed" && request.error && request.routing_issue === "delivery") {
        this.defer(request, POLL_MS);
        return;
      }
      this.update(request, { state: "accepted", session_id: null, previous_session_id: sessionId, delivery: null,
        delivery_at: null, routing_issue: null, error: null, retry_at: 0 });
      return;
    }
    if (request.delivery === "claimed") {
      await this.observeDelegation(request, project, task, run, assignedWorker);
      return;
    }
    if (request.delivery === "sending" || request.delivery === "sent") {
      if (this.ports.now() - (request.delivery_at ?? 0) > DESK_LAUNCH_CONFIRM_WINDOW_MS) {
        this.deliveryIssue(request, "プロジェクト管制の委託受付を待っています。");
      } else this.defer(request);
      return;
    }
    if (this.stopping || this.ports.isCostBlocked() || !controller.idle || !this.ports.canDeliver(sessionId, request.id, task.path)) {
      this.defer(request);
      return;
    }
    if (!run && !assignedWorker && canOfferDeskRequest(this.occupiedSlots(project.code, request.id))) {
      await this.ports.assign(project.repoPath, task.path, sessionId, null);
    }
    if (this.stopping || this.ports.projectControl(project)?.id !== sessionId) { this.defer(request); return; }
    this.offer(request, project, task.path, sessionId, run);
  }

  private offer(request: DeskRequest, project: DeskProject, reference: string, sessionId: string, run: DeskDelegationRun | null): void {
    // Persist intent before notifying so a late claim still competes with reassignment by revision.
    const sending = this.repo.transaction(() => {
      if (run?.state !== "active" && !canOfferDeskRequest(this.occupiedSlots(project.code, request.id))) return null;
      return this.repo.transition(request, { delivery: "sending", delivery_at: this.ports.now(), retry_at: 0 }, this.ports.now());
    });
    if (!sending) { this.defer(request); return; }
    try {
      this.ports.deliver(sessionId, request.id, reference);
      this.update(sending, { delivery: "sent", error: null, retry_at: this.ports.now() + POLL_MS });
    } catch (error) {
      this.ports.logError(error);
      this.update(sending, { routing_issue: "delivery", error: "受け箱への配達結果を確認してください。",
        retry_at: this.ports.now() + POLL_MS });
    }
  }

  private async observeDelegation(request: DeskRequest, project: DeskProject, task: TaskDocument,
    run: DeskDelegationRun | null, worker: string | null): Promise<void> {
    if (run?.state === "active") {
      if (request.routing_issue) this.update(request, { routing_issue: null, error: null, retry_at: this.ports.now() + POLL_MS });
      else this.defer(request, POLL_MS);
      return;
    }
    if (run?.state === "failed") { this.deliveryIssue(request, "委託が失敗しました。子の作業と終了を確認してください。"); return; }
    if (run?.state === "completed" || run?.isRetry || task.runtime?.pr_number != null
      || (!run && task.runtime?.status !== "pending")) {
      this.deliveryIssue(request, "既存の委託の結果と Actio タスクの状態を確認してください。");
      return;
    }
    if ((worker && worker !== request.session_id) || this.stopping || this.ports.isCostBlocked()
      || !canOfferDeskRequest(this.occupiedSlots(project.code, request.id))) {
      this.defer(request, POLL_MS);
      return;
    }
    if (request.error === DELEGATION_UNCONFIRMED) { this.defer(request, POLL_MS); return; }
    const reserved = this.update(request, { error: DELEGATION_UNCONFIRMED,
      retry_at: this.ports.now() + POLL_MS });
    if (!reserved) return;
    // The delegation lifecycle assigns the child using a compare-and-set from null.
    if (worker) await this.ports.assign(project.repoPath, task.path, null, worker);
    if (this.stopping || this.ports.projectControl(project)?.id !== request.session_id) {
      this.update(reserved, { routing_issue: null, error: null, retry_at: 0 });
      return;
    }
    const accepted = await this.ports.delegate(reserved, project, run !== null);
    if (accepted) this.update(reserved, { routing_issue: null, error: null });
    else this.deliveryIssue(reserved, DELEGATION_UNCONFIRMED);
  }

  private occupiedSlots(projectCode: string, requestId: string): number {
    return this.repo.offeredRequests(projectCode).filter((other) => {
      if (other.id === requestId) return false;
      const run = this.ports.delegationRun(other.id);
      if (run?.state === "active" || other.error === DELEGATION_UNCONFIRMED) return true;
      if (other.delivery === "sending" || other.delivery === "sent") return true;
      return other.delivery === "claimed" && !run && other.session_id !== null && this.ports.isProjectControl(other.session_id);
    }).length;
  }

  private deliveryIssue(request: DeskRequest, error: string): void {
    this.update(request, { routing_issue: "delivery", error, retry_at: this.ports.now() + POLL_MS });
  }

  private launchFailed(request: DeskRequest, error: string): void {
    this.update(request, { state: "launch_failed", routing_issue: "launch", error });
  }

  private defer(request: DeskRequest, delay = WAIT_MS): void {
    this.update(request, { retry_at: this.ports.now() + delay });
  }

  private update(request: DeskRequest, patch: DeskRequestPatch): DeskRequest | null {
    const next = this.repo.transition(request, patch, this.ports.now());
    if (next && (next.state !== request.state || next.task_reference !== request.task_reference
      || next.routing_issue !== request.routing_issue || next.delivery !== request.delivery)) {
      this.notifyChange(next);
    }
    return next;
  }

  private notifyChange(request: DeskRequest): void {
    try { this.ports.onChange(request); } catch (error) { this.ports.logError(error); }
  }
}
