/** All timestamps are epoch seconds. Closure does not constitute an answer. */
export const TASKFLOW_QUESTION_GRACE_SEC = 86_400;

export function questionClosureDeadline(input: {
  active: boolean;
  taskflow: boolean;
  inactiveAt: number;
  deadline: number | null;
}): number | null {
  if (input.active) return null;
  return input.deadline ?? input.inactiveAt + (input.taskflow ? TASKFLOW_QUESTION_GRACE_SEC : 0);
}
