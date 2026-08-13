import type { DelegationRepo, DelegationRunRow } from "../db/delegation-repo.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationService } from "../delegation/service.js";
import { eventBus } from "../events.js";
import { scheduleTeardownLadder } from "./teardown-ladder.js";
import { createChildLogger } from "../shared/logger.js";
import { inheritDelegationRuntime } from "../delegation/continuation-runtime.js";

const log = createChildLogger("ask-detach");

function args(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function resume(run: DelegationRunRow, answer: string, service: DelegationService): Promise<void> {
  const result = await service.invoke({
    call_name: run.call_name,
    args: args(run.args_json),
    parent_session_id: run.parent_session_id,
    cwd: run.spawn_worktree_path ?? run.spawn_cwd ?? undefined,
    branch: run.spawn_branch ?? undefined,
    worktree: false,
    triggered_by: `ask-resume:${run.id}`,
    ...inheritDelegationRuntime(run),
    extra_prompt: `前 run ${run.id} は質問待ちで切り離されました。回答を初回文脈として再開してください。\n\n回答: ${answer}`,
  });
  if (!result.ok) throw new Error(result.error);
}
export function startAskDetachWatch(input: { sessions: SessionsRepo; runs: DelegationRepo; questions: DiscordPendingQuestionsRepo; service: DelegationService; detachSec?: number; intervalMs?: number; nowSec?: () => number }): { stop(): void } {
  const detachSec = input.detachSec ?? Number(process.env.CONCORDIA_ASK_DETACH_SEC ?? 1800);
  if (!Number.isFinite(detachSec) || detachSec <= 0) throw new Error("invalid ask detach interval");
  const nowSec = input.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const scan = (): void => {
    const now = nowSec();
    for (const run of input.runs.listActiveRuns()) {
      if (!run.child_session_id) continue;
      const question = input.questions.findLatestUnanswered(run.child_session_id);
      if (!question || now - question.ts < detachSec) continue;
      input.questions.appendQuestionNotice(question.id, "回答すると新しい run で再開します");
      input.runs.updateRunStatus(run.id, "blocked", `awaiting_question:${question.id}`);
      const session = input.sessions.findSession(run.child_session_id);
      if (!session) continue;
      input.sessions.mergeMetadata(session.id, { ask_detached_run_id: run.id, ask_detached_question_id: question.id });
      input.sessions.appendEvent({ session_id: session.id, ts: now, kind: "ask_detached", payload: { run_id: run.id, question_id: question.id, note: "回答すると新しい run で再開します" } });
      scheduleTeardownLadder(input.sessions, session, `ask-detach:${run.id}`, now);
    }
  };
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.type !== "question.answered") return;
    const run = input.runs.recentRuns(500).find((candidate) => candidate.status === "blocked" && candidate.child_session_id === event.target_session_id && candidate.error === `awaiting_question:${event.question_id}`);
    if (run) void resume(run, event.answer_text, input.service).catch((error) => log.warn({ error, run_id: run.id }, "ask detach resume failed"));
  });
  const timer = setInterval(scan, input.intervalMs ?? 30_000); timer.unref?.();
  return { stop: () => { clearInterval(timer); unsubscribe(); } };
}
