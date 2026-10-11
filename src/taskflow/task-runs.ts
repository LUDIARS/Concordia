/**
 * run と task の多対 1 (spec/feature/task-workflow-v3.md §run と task)。
 *
 * 1 つの Actio task に、委託の実行回 (run) を pluginPayload.runs[] として追記していく。
 * 同時に作業する run は 1 つだけなので、新しい run を記録するときは、終わっていない前の run を閉じる。
 */
import { z } from "zod";

export const TaskRunEntry = z.object({
  run_id: z.string().min(1),
  session_id: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable().optional(),
});
export type TaskRunEntry = z.infer<typeof TaskRunEntry>;

export function taskRuns(payload: Record<string, unknown> | null | undefined): TaskRunEntry[] {
  const parsed = z.array(TaskRunEntry).safeParse(payload?.runs);
  return parsed.success ? parsed.data : [];
}

/** run の開始を記録する。同じ run の再記録は何も変えない (応答を失った再試行)。 */
export function startTaskRun(
  payload: Record<string, unknown> | null | undefined,
  run: { runId: string; sessionId: string | null; at: string },
): Record<string, unknown> {
  const runs = taskRuns(payload);
  if (runs.some((entry) => entry.run_id === run.runId)) return { ...payload };
  const closed = runs.map((entry) => entry.ended_at === null
    ? { ...entry, ended_at: run.at, end_reason: "superseded" } : entry);
  return { ...payload, runs: [...closed, { run_id: run.runId, session_id: run.sessionId, started_at: run.at, ended_at: null }] };
}

/** run の終了を記録する。記録の無い run・閉じ済みの run は何も変えない。 */
export function endTaskRun(
  payload: Record<string, unknown> | null | undefined,
  run: { runId: string; at: string; reason: string },
): Record<string, unknown> {
  const runs = taskRuns(payload);
  if (!runs.some((entry) => entry.run_id === run.runId && entry.ended_at === null)) return { ...payload };
  return { ...payload, runs: runs.map((entry) => entry.run_id === run.runId && entry.ended_at === null
    ? { ...entry, ended_at: run.at, end_reason: run.reason } : entry) };
}

/**
 * 続きの委託で渡された新しい指示を本文の末尾へ追記する。本文は Actio にだけ置くので、
 * 子は追記込みの本文を Actio から読む。同じ指示が既に含まれていれば追記しない。
 */
export function appendTaskInstruction(description: string, runId: string, instruction: string): string {
  const text = instruction.trim();
  if (!text || description.includes(text)) return description;
  return `${description.trimEnd()}\n\n---\n\n## 続きの指示 (run ${runId})\n\n${text}`;
}
