/** @implements spec/feature/task-linked-followup.md — followup sources fetched independently */
import type { RevisorRepositoryRecord } from "../pr/revisor-repository-client.js";
import type { SessionRow } from "../shared/types.js";
import { selectProjectStartupWorkflow } from "./project-startup-workflow.js";
import type { FollowupSource, SessionFollowupSnapshot } from "./session-followup-state.js";

interface PrState { status: string; checkStatus: string }

export interface FollowupSnapshotPorts {
  linkedTasks(sessionId: string): Promise<{ kind: string; links: readonly { status: string; reason?: string }[] }>;
  repositories(): Promise<readonly RevisorRepositoryRecord[]>;
  localPrs(): Promise<readonly (PrState & { sessionId?: string | null; headRef: string })[]>;
  githubPrs(session: SessionRow): readonly PrState[];
  delegations(sessionId: string): readonly { status: string }[];
}

/**
 * Actio・Revisor 登録一覧・Revisor local PR を個別に取得する。1 つの失敗で他の結果を捨てず、
 * 取れなかった取得元を unavailable に残す (以前は 1 つの例外で snapshot 全体が消え、
 * 一律に「Actio・審査・委託状態は取得できていません」と表示していた)。
 */
export async function resolveSessionFollowupSnapshot(
  ports: FollowupSnapshotPorts, session: SessionRow,
): Promise<SessionFollowupSnapshot> {
  const unavailable: FollowupSource[] = [];
  const [live, registrations] = await Promise.allSettled([ports.linkedTasks(session.id), ports.repositories()]);
  if (live.status === "rejected") unavailable.push("actio");
  if (registrations.status === "rejected") unavailable.push("revisor-registry");
  const workflow = registrations.status === "fulfilled"
    ? selectProjectStartupWorkflow(registrations.value, session.repo_path, session.repo_origin)
    : "unknown";
  let prs: readonly PrState[] = [];
  if (workflow === "github") {
    prs = ports.githubPrs(session);
  } else if (workflow === "revisor") {
    try {
      prs = (await ports.localPrs()).filter((pr) => pr.sessionId === session.id && pr.headRef === session.branch);
    } catch {
      unavailable.push("revisor-prs");
    }
  }
  const tasks = live.status === "fulfilled" && live.value.kind === "current"
    ? live.value.links.map((link) => ({ status: link.status, ...(link.reason ? { reason: link.reason } : {}) }))
    : [{ status: "unknown" }];
  return { workflow, tasks, delegations: ports.delegations(session.id), prs, unavailable };
}
