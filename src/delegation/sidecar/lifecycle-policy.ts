/** Resident lifetime is independent of terminal work results. SC-LIFE-01..04. */
export type ResidentState = "starting" | "busy" | "idle" | "closing" | "closed";
export interface ResidentChild {
  id: string; parent_id: string; generation: string; repo_path: string;
  organization: string; provider: string; model: string; state: ResidentState;
  child_session_id: string | null; current_run_id: string | null; branch: string;
}
export interface ResidentMarker { id: string; generation: string; parentId: string }
export function readResidentMarker(metadata: string | null): ResidentMarker | null {
  try {
    const marker = (JSON.parse(metadata ?? "{}") as Record<string, unknown>).cc_resident_child as Partial<ResidentMarker> | undefined;
    return marker && typeof marker.id === "string" && typeof marker.generation === "string" && typeof marker.parentId === "string"
      ? marker as ResidentMarker : null;
  } catch { return null; }
}
export function decideResidentReuse(child: ResidentChild, input: {
  parentId: string; repoPath: string; organization: string; branch: string;
  childActive: boolean; generationMatches: boolean;
}): string | null {
  if (child.parent_id !== input.parentId || child.repo_path !== input.repoPath
    || child.organization !== input.organization || child.branch !== input.branch) return "resident_scope_mismatch";
  if (child.state !== "idle") return `resident_${child.state}`;
  if (!input.childActive || !input.generationMatches) return "resident_presence_unknown";
  return null;
}
export function matchesResidentResult(child: ResidentChild, runId: string, generation: string): boolean {
  return child.state === "busy" && child.current_run_id === runId && child.generation === generation;
}
