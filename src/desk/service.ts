/**
 * 依頼窓口の受付・一覧の use case (spec/feature/request-desk.md)。
 * Web と Discord は同じ submit を呼ぶ (CC-V5-INV-07)。判定は desk-request-policy.ts、保存は DeskRepository。
 *
 * @implements spec/feature/request-desk.md — 受付 (CC-V5-INV-01)
 */
import {
  DESK_REQUESTER_MAX_CHARS,
  decideSubmission,
  deskBodyProblem,
  originOfRequestKey,
  type DeskProvider,
  type DeskRequest,
} from "./desk-request-policy.js";
import type { DeskRepository } from "./repository.js";
import type { DeskDelegationRun } from "./project-control-delegation.js";
import type { DeskProject } from "./routing-policy.js";

export interface SubmitDeskInput {
  requestKey: string;
  requester: string;
  provider: DeskProvider;
  body: string;
  project?: string;
}

export type SubmitDeskOutcome =
  | { kind: "created" | "existing"; request: DeskRequest }
  | { kind: "conflict"; request: DeskRequest }
  | { kind: "invalid"; problem: string }
  | { kind: "disabled" };

export interface DeskServicePorts {
  now: () => number;
  id: () => string;
  isEnabled: () => boolean;
  projects?: () => DeskProject[];
  canClaim?: (sessionId: string, project: DeskProject) => boolean;
  delegationRun?: (requestId: string) => DeskDelegationRun | null;
  requestForChildSession?: (sessionId: string) => string | null;
}

export class DeskService {
  constructor(readonly repo: DeskRepository, private readonly ports: DeskServicePorts) {}

  submit(input: SubmitDeskInput): SubmitDeskOutcome {
    const origin = originOfRequestKey(input.requestKey);
    if (!origin) return { kind: "invalid", problem: "受付キーの形が違います" };
    const problem = deskBodyProblem(input.body);
    if (problem) return { kind: "invalid", problem };
    const requester = input.requester.trim().slice(0, DESK_REQUESTER_MAX_CHARS) || "unknown";
    return this.repo.transaction((): SubmitDeskOutcome => {
      const existing = this.repo.findByKey(input.requestKey);
      const decision = decideSubmission(existing, input);
      // 受付済みの再送は OFF 後でも既存を返す (結果不明の照合を止めない)。
      if (decision === "existing") return { kind: "existing", request: existing! };
      if (decision === "conflict") return { kind: "conflict", request: existing! };
      if (!this.ports.isEnabled()) return { kind: "disabled" };
      const request = this.repo.insert({
        id: this.ports.id(), request_key: input.requestKey, origin, requester, provider: input.provider, body: input.body.trim(),
        routing_enabled: this.ports.projects ? 1 : 0, requested_project: input.project?.trim().toLowerCase() || null,
      }, this.ports.now());
      return { kind: "created", request };
    });
  }

  projects(): Array<Pick<DeskProject, "code" | "name">> {
    return (this.ports.projects?.() ?? []).map(({ code, name }) => ({ code, name }));
  }

  selectProject(id: string, code: string): DeskRequest | null {
    const request = this.repo.find(id);
    const project = this.project(code);
    if (!project || request?.routing_issue !== "project") return null;
    return this.repo.transition(request, { project_code: project.code, routing_issue: null, error: null }, this.ports.now());
  }

  retryLaunch(id: string): DeskRequest | null {
    const request = this.repo.find(id);
    if (!request || request.routing_issue !== "launch") return null;
    return this.repo.transition(request, {
      state: "accepted", routing_issue: null, error: null, retry_at: 0,
    }, this.ports.now());
  }

  claim(id: string, sessionId: string): DeskRequest | null {
    const request = this.repo.find(id);
    if (request?.state !== "running" || request.session_id !== sessionId || !request.task_reference) return null;
    const project = this.project(request.project_code ?? "");
    if (!project || project.repoPath !== request.routing_repo || !this.ports.canClaim?.(sessionId, project)) return null;
    if (request.delivery === "claimed") return request;
    if (request.delivery !== "sending" && request.delivery !== "sent") return null;
    return this.repo.transition(request, { delivery: "claimed", routing_issue: null, error: null }, this.ports.now());
  }

  private project(code: string): DeskProject | null {
    return this.ports.projects?.().find((item) => item.code.toLowerCase() === code.trim().toLowerCase()) ?? null;
  }

  list(limit = 50): DeskRequest[] {
    return this.repo.list(Math.max(1, Math.min(limit, 200)));
  }

  get(id: string): DeskRequest | null {
    return this.repo.find(id);
  }

  delegationRun(id: string): DeskDelegationRun | null {
    return this.ports.delegationRun?.(id) ?? null;
  }

  findBySession(sessionId: string): DeskRequest | null {
    const requestId = this.ports.requestForChildSession?.(sessionId);
    return (requestId ? this.repo.find(requestId) : null) ?? this.repo.findBySession(sessionId);
  }

  attachThread(id: string, threadId: string): boolean {
    return this.repo.attachThread(id, threadId);
  }
}
