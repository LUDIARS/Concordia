import type { DelegationRunRow } from "../db/delegation-repo.js";

const TASK_KEYS = ["task", "problem", "child_task", "summary", "design_path"] as const;
const LABEL_LIMIT = 180;

export interface DelegatedChildSummary {
  runId: string;
  callName: string;
  taskLabel: string;
  childSessionId: string | null;
  status: DelegationRunRow["status"];
}

export function projectDelegatedChildRun(
  run: Pick<DelegationRunRow, "id" | "call_name" | "args_json" | "child_session_id" | "status">,
): DelegatedChildSummary {
  return {
    runId: run.id,
    callName: run.call_name,
    taskLabel: extractDelegatedTaskLabel(run.args_json, run.call_name),
    childSessionId: run.child_session_id,
    status: run.status,
  };
}

export function extractDelegatedTaskLabel(argsJson: string, fallback: string): string {
  const args = parseArgs(argsJson);
  for (const key of TASK_KEYS) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const normalized = normalizeLabel(value);
    if (normalized) return truncate(normalized, LABEL_LIMIT);
  }
  return truncate(normalizeLabel(fallback) || "delegated task", LABEL_LIMIT);
}

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeLabel(value: string): string {
  return redactSecrets(value.replace(/\s+/g, " ").trim());
}

function truncate(value: string, limit: number): string {
  const codePoints = [...value];
  return codePoints.length <= limit ? value : `${codePoints.slice(0, limit - 3).join("")}...`;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[REDACTED]",
    );
}
