import { eventBus } from "../events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { TaskMdStore } from "./md-store.js";

export const DECOMPOSE_PROMPT = [
  "作業内容を task-workflow spec §2.1 の frontmatter 形式で、対象リポの spec/tasks/ に分解保存してください。",
  "残作業として保存すべきタスクが無い場合は『タスク無し』と報告してください。",
].join("\n");

const injectedRuns = new Set<string>();

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
  injectedRuns.add(input.run.id);
  input.sessions.appendEvent({ session_id: target, ts: Math.floor(Date.now() / 1000), kind: "inject", payload: { text: DECOMPOSE_PROMPT, source: `taskflow:${input.run.id}:decompose` } });
  eventBus.emit({ type: "session.inject", target_session_id: target, text: DECOMPOSE_PROMPT, source: `taskflow:${input.run.id}:decompose`, ts: Math.floor(Date.now() / 1000) });
  return true;
}
