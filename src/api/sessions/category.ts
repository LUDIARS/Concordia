/** Taskflow membership comes from the linked run, never from the conversation title. */
export function sessionCategory(metadata: string | null, findRun: (id: string) => { args_json: string } | null): "taskflow" | "conversation" {
  try {
    const meta = JSON.parse(metadata ?? "{}") as Record<string, unknown>;
    const run = typeof meta.delegation_run_id === "string" ? findRun(meta.delegation_run_id) : null;
    const args = JSON.parse(run?.args_json ?? "{}") as Record<string, unknown>;
    return typeof args.taskflow_reference === "string" && args.taskflow_reference.startsWith("actio:") ? "taskflow" : "conversation";
  } catch {
    // Legacy malformed metadata cannot prove taskflow ownership; keep its chat visible.
    return "conversation";
  }
}
