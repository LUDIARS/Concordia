/**
 * Lictor で包んだセッションを通常の終了手順で止める (admin stop-session と予算切れの中断が共有する)。
 *
 * 1. session row の metadata.lictor_pid を確かめる
 * 2. session を ended にして end event を残す (stopped_by は呼び出し元が決める)
 * 3. session-end フローを確定し、 report 生成 / 独白投稿は非同期で予約する
 * 4. durable control queue へ停止ジョブを登録する (taskkill / signal は control-worker が実行する)
 *
 * @implements spec/feature/usage-budgets.md §5.2
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ControlJobsRepo } from "../db/control-jobs-repo.js";
import { runSessionEndFlow, type EndSessionFlowDeps } from "./end-session-flow.js";

export interface WrappedSessionStopDeps {
  repo: SessionsRepo;
  controlJobs: Pick<ControlJobsRepo, "enqueueStopProcess">;
  endFlow: EndSessionFlowDeps;
  nowSec?: () => number;
}

export type WrappedSessionStopResult =
  | {
    ok: true;
    pid: number;
    agentClientPid: number | null;
    jobId: ReturnType<ControlJobsRepo["enqueueStopProcess"]>["id"];
    agentClientJobId: ReturnType<ControlJobsRepo["enqueueStopProcess"]>["id"] | null;
  }
  | { ok: false; status: 400 | 404; error: string };

export async function stopWrappedSession(
  deps: WrappedSessionStopDeps,
  id: string,
  input: { stoppedBy: string; source: string },
): Promise<WrappedSessionStopResult> {
  const session = deps.repo.findSession(id);
  if (!session) return { ok: false, status: 404, error: "not_found" };
  if (!session.metadata) return { ok: false, status: 400, error: "session has no metadata — was it lictor-wrapped?" };
  let meta: { lictor_pid?: number; agent_client_pid?: number };
  try {
    meta = JSON.parse(session.metadata) as { lictor_pid?: number; agent_client_pid?: number };
  } catch {
    return { ok: false, status: 400, error: "session.metadata is not JSON" };
  }
  if (typeof meta.lictor_pid !== "number") return { ok: false, status: 400, error: "session.metadata.lictor_pid missing" };
  const now = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  deps.repo.setStatus(id, "ended", now, now);
  deps.repo.appendEvent({
    session_id: id,
    ts: now,
    kind: "end",
    payload: { stopped_by: input.stoppedBy, duration_sec: now - session.started_at },
  });
  await runSessionEndFlow(deps.endFlow, deps.repo.findSession(id)!);
  const lictorJob = deps.controlJobs.enqueueStopProcess({
    pid: meta.lictor_pid,
    source: input.source,
    sessionId: id,
    role: "lictor",
    expectedCommand: null,
  });
  const agentClientJob = typeof meta.agent_client_pid === "number"
    ? deps.controlJobs.enqueueStopProcess({
      pid: meta.agent_client_pid,
      source: input.source,
      sessionId: id,
      role: "agent-client",
      expectedCommand: null,
    })
    : null;
  return {
    ok: true,
    pid: meta.lictor_pid,
    agentClientPid: meta.agent_client_pid ?? null,
    jobId: lictorJob.id,
    agentClientJobId: agentClientJob?.id ?? null,
  };
}
