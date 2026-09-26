/** Actio owns these optional fields; never infer provenance from legacy state. */
export interface TaskSessionMetadata {
  issued_by_session_id: string | null;
  working_session_id: string | null;
}

export function taskSessionMetadata(payload: Record<string, unknown> | null | undefined): TaskSessionMetadata {
  const session = (key: string): string | null => {
    const value = payload?.[key];
    if (value == null) return null;
    if (typeof value !== "string" || !value.trim()) throw new Error("Invalid Actio session metadata");
    return value;
  };
  return { issued_by_session_id: session("issued_by_session_id"), working_session_id: session("working_session_id") };
}

/** A repeated operation is harmless; a delayed release cannot remove a successor. */
export function assignTaskWorker(
  payload: Record<string, unknown> | null, worker: string | null, expected?: string | null,
): Record<string, unknown> {
  const current = taskSessionMetadata(payload);
  if (expected !== undefined && current.working_session_id !== expected && current.working_session_id !== worker) {
    throw new Error("Task working session changed");
  }
  return { ...payload, ...current, working_session_id: worker };
}
