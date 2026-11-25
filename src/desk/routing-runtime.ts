import { isSessionIdle, type LastTranscriptFrame } from "../control/succession/session-idle.js";
import { sessionWorkingRepoPath } from "../control/session-working-repo.js";
import { eventBus } from "../events.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import type { SessionRow } from "../shared/types.js";
import { repositoryKey } from "../taskflow/actio-binding.js";
import type { ActioTaskStore } from "../taskflow/actio-store.js";
import type { DeskRepository } from "./repository.js";
import { createDeskDelegationPorts, type DeskDelegationDeps } from "./project-control-delegation.js";
import { currentProjectControl, deskTaskTitle, type DeskProject } from "./routing-policy.js";

const SOURCE = "auto:desk-actio";
export const PROJECT_CONTROL_ROLE = "desk-project-control";

export function isDeskResident(metadata: string | null): boolean {
  try {
    const role = JSON.parse(metadata ?? "{}")?.delegation_call_name;
    return role === PROJECT_CONTROL_ROLE || role === "desk-project-resident";
  }
  catch { return false; } // Malformed historical metadata is never a resident role.
}

function controlSpawnId(metadata: string | null): string | null {
  try {
    const data = JSON.parse(metadata ?? "{}");
    return data?.delegation_call_name === PROJECT_CONTROL_ROLE && typeof data.concordia_spawn_id === "string"
      ? data.concordia_spawn_id : null;
  } catch { return null; } // Unparseable metadata cannot prove ownership.
}

export interface DeskRoutingRuntimeDeps {
  projects(): Array<DeskProject & { repoOrigin: string | null }>;
  taskStore: Pick<ActioTaskStore, "create" | "read" | "setWorkingSession">;
  activeSessions(): SessionRow[];
  session(sessionId: string): SessionRow | null;
  excludeSession(session: SessionRow): boolean;
  isStalled(sessionId: string): boolean;
  lastFrame(sessionId: string): LastTranscriptFrame | null;
  delegation: DeskDelegationDeps;
}

export function createDeskRoutingPorts(deps: DeskRoutingRuntimeDeps, repo: DeskRepository, concordiaUrl: string) {
  const base = concordiaUrl.replace(/\/+$/, "");
  const delegation = createDeskDelegationPorts(deps.delegation);
  const retiredNotices = new Set<string>();
  const matchesRepo = (session: SessionRow, project: DeskProject) =>
    repositoryKey(session.repo_path) === repositoryKey(project.repoPath);
  const runList = (sessionId: string) => `${base}/v1/delegation/runs?parent_session=${encodeURIComponent(sessionId)}`;
  const event = (sessionId: string, requestId: string, reference: string) => {
    const run = delegation.delegationRun(requestId);
    return {
      type: "session.inject" as const, target_session_id: sessionId, source: SOURCE, ts: Math.floor(Date.now() / 1000),
      text: [
        `[プロジェクト管制の受け箱] Actio タスク ${reference}`,
        `POST ${base}/v1/desk/requests/${requestId}/claim へ {"session_id":"${sessionId}"} を送り、委託受付を確定してください。409 なら現在の管制に任せてください。`,
        run ? `引き継ぐ既存の委託 run は ${run.id} です。GET ${base}/v1/delegation/runs/${run.id}/status で照合してください。`
          : `Cc が Sol に払い出します。GET ${runList(sessionId)} で run を確認してください。`,
        "cc-project-control スキルに従い、子の停滞・失敗と成果を確認してください。人間の判断や操作は既存の管制カードに出してください。",
      ].join("\n"),
    };
  };
  return {
    projects: deps.projects,
    createTask: (request: { id: string; body: string }, repoPath: string) => deps.taskStore.create({
      repoPath, subsidiaryId: null, sourceRef: `desk:${request.id}`, title: deskTaskTitle(request.body),
      body: request.body, kind: "実装", memoryLinks: [],
    }),
    readTask: (repoPath: string, reference: string) => deps.taskStore.read(repoPath, reference, null),
    assign: (repoPath: string, reference: string, sessionId: string | null, expected: string | null) =>
      deps.taskStore.setWorkingSession(repoPath, reference, sessionId, null, expected),
    ...delegation,
    isProjectControl: (sessionId: string) => controlSpawnId(deps.session(sessionId)?.metadata ?? null) !== null,
    projectControl(project: DeskProject) {
      const reservation = repo.projectLaunch(project.code);
      if (!reservation?.spawn_id || reservation.state === "launch_failed") return null;
      const registration = deps.projects().find(({ code }) => code === project.code);
      const origin = registration?.repoOrigin ? normalizeRepoOrigin(registration.repoOrigin).toLowerCase() : null;
      const sessions = deps.activeSessions().flatMap((session) => {
        const spawnId = controlSpawnId(session.metadata);
        if (spawnId !== reservation.spawn_id || readSubsidiaryId(session.metadata) !== null || !matchesRepo(session, project)
          || deps.excludeSession(session)) return [];
        const workingRepo = sessionWorkingRepoPath(session);
        if (workingRepo !== session.repo_path && repositoryKey(workingRepo) !== repositoryKey(project.repoPath)
          && ![project.code, project.name].some((name) => name.toLowerCase() === workingRepo.toLowerCase())) return [];
        if (session.repo_origin && origin && normalizeRepoOrigin(session.repo_origin).toLowerCase() !== origin) return [];
        const last = deps.lastFrame(session.id);
        const idle = !!last && last.ts * 1000 > repo.latestDelivery(session.id)
          && isSessionIdle(last, Math.floor(Date.now() / 1000), 2);
        if (deps.isStalled(session.id) && (!idle || repo.hasOutstandingDelivery(session.id))) return [];
        return [{ id: session.id, spawnId, idle }];
      });
      return currentProjectControl(sessions, reservation.spawn_id);
    },
    hasResidentCapacity: (replacingProject: string) => deps.projects().filter((project) => {
      if (project.code === replacingProject) return false;
      const reservation = repo.projectLaunch(project.code);
      if (!reservation?.spawn_id || reservation.state === "launch_failed" || reservation.state === "launching"
        || reservation.state === "launch_unknown") return false;
      return deps.activeSessions().some((session) => controlSpawnId(session.metadata) === reservation.spawn_id
        && matchesRepo(session, project) && !deps.excludeSession(session));
    }).length + repo.pendingLaunches("").total < 8,
    retireSuperseded(): void {
      const sessions = deps.activeSessions();
      const activeIds = new Set(sessions.map((session) => session.id));
      for (const id of retiredNotices) if (!activeIds.has(id)) retiredNotices.delete(id);
      for (const project of deps.projects()) {
        const current = repo.projectLaunch(project.code);
        if (!current?.spawn_id || current.state === "launch_failed" || current.state === "launching" || current.state === "launch_unknown") continue;
        const controllers = sessions.filter((session) => matchesRepo(session, project) && readSubsidiaryId(session.metadata) === null
          && controlSpawnId(session.metadata) !== null);
        if (!controllers.some((session) => controlSpawnId(session.metadata) === current.spawn_id && !deps.excludeSession(session))) continue;
        for (const old of controllers) {
          if (controlSpawnId(old.metadata) === current.spawn_id || retiredNotices.has(old.id)) continue;
          const notice = {
            type: "session.inject" as const, target_session_id: old.id, source: SOURCE, ts: Math.floor(Date.now() / 1000),
            text: "プロジェクト管制は次の世代へ引き継がれました。子の作業は保持し、この管制セッションは session-end してください。",
          };
          if (!eventBus.canDeliverInject(notice)) continue;
          eventBus.emit(notice);
          retiredNotices.add(old.id);
        }
      }
    },
    canDeliver: (sessionId: string, requestId: string, reference: string) =>
      deps.activeSessions().some((session) => session.id === sessionId && session.ws_clients > 0)
        && eventBus.canDeliverInject(event(sessionId, requestId, reference)),
    deliver: (sessionId: string, requestId: string, reference: string) => eventBus.emit(event(sessionId, requestId, reference)),
  };
}
