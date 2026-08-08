import { eventBus } from "../events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { TaskMdStore } from "./md-store.js";

export const DECOMPOSE_PROMPT = [
  "作業内容を task-workflow spec §2.1 の frontmatter 形式で、対象リポの spec/tasks/ に分解保存してください。",
  "残作業として保存すべきタスクが無い場合は『タスク無し』と報告してください。",
].join("\n");

const injectedRuns = new Set<string>();

/**
 * 同一 run への分解 inject が既に永続イベントとして残っているか。 in-memory の
 * `injectedRuns` はプロセス再起動で消え、 再起動後に同じ run へ分解プロンプトが
 * 再送されていた。 session_events の inject (source=taskflow:<run>:decompose) を
 * 正本として exactly-once を保証する (session-end.ts の auto:session-end と同型)。
 */
function alreadyInjected(sessions: SessionsRepo, sessionId: string, runId: string): boolean {
  const source = `taskflow:${runId}:decompose`;
  return sessions.recentEvents(sessionId, 200).some((event) => {
    if (event.kind !== "inject") return false;
    try {
      return (JSON.parse(event.payload) as { source?: unknown }).source === source;
    } catch {
      return false;
    }
  });
}

export async function injectDecompositionWhenMissing(input: {
  run: DelegationRunRow;
  sessions: SessionsRepo;
  store: TaskMdStore;
}): Promise<boolean> {
  if (injectedRuns.has(input.run.id)) return false;
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(input.run.args_json) as Record<string, unknown>; } catch { /* empty */ }
  const project = [args.target_repo, args.repo_path, args.cwd].find((value): value is string => typeof value === "string")
    ?? (input.run.child_session_id ? input.sessions.findSession(input.run.child_session_id)?.repo_path : null);
  if (!project) return false;
  const existing = await input.store.findForProject(project, ["pending", "delegated"]);
  if (existing.length > 0) return false;
  const target = input.run.parent_session_id ?? input.run.child_session_id;
  if (!target) return false;
  if (alreadyInjected(input.sessions, target, input.run.id)) {
    injectedRuns.add(input.run.id);
    return false;
  }
  injectedRuns.add(input.run.id);
  input.sessions.appendEvent({ session_id: target, ts: Math.floor(Date.now() / 1000), kind: "inject", payload: { text: DECOMPOSE_PROMPT, source: `taskflow:${input.run.id}:decompose` } });
  eventBus.emit({ type: "session.inject", target_session_id: target, text: DECOMPOSE_PROMPT, source: `taskflow:${input.run.id}:decompose`, ts: Math.floor(Date.now() / 1000) });
  return true;
}
