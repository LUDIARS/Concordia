/** Pure work-target identity for residual decisions spanning asynchronous reads. */
import type { SessionRow } from "../shared/types.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";

export function residualBinding(session: SessionRow) {
  return { id:session.id,repo_path:session.repo_path,repo_origin:session.repo_origin,branch:session.branch,
    subsidiary:readSubsidiaryId(session.metadata),current_task:session.current_task,
    target_project:session.target_project,team_id:session.team_id,department_id:session.department_id,
    active_repos:session.active_repos };
}
export function matchesResidualBinding(expected: ReturnType<typeof residualBinding>, latest: SessionRow | null): boolean {
  if (!latest || latest.status !== "active") return false;
  const actual = residualBinding(latest);
  return (Object.keys(expected) as Array<keyof typeof expected>).every(key => expected[key] === actual[key]);
}
