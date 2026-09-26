import type { SessionsRepo } from "../db/sessions-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { RevisorLocalPrReader } from "../pr/revisor-client.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { extractTaskMdPath } from "../control/goal-and-go.js";
import { findSessionLocalPr, findSessionPr } from "./goal-machine.js";
import type { TaskStore } from "./store.js";
import type { TaskPrEvidence } from "./pr-evidence.js";

/** Synchronize only this session's exact task/repository; never infer from PR number. */
export async function syncSessionPrEvidence(input: {
  sessionId: string; sessions: SessionsRepo; prs: PrRecordsRepo;
  revisor?: RevisorLocalPrReader; store: TaskStore; now?: () => Date;
}): Promise<void> {
  if (!input.store.setPrEvidence) return;
  const session = input.sessions.findSession(input.sessionId);
  if (!session?.repo_origin || !session.branch) return;
  const repository = normalizeRepoOrigin(session.repo_origin).toLowerCase();
  const subsidiary = readSubsidiaryId(session.metadata);
  const tasks = await input.store.findForProject(session.repo_path, undefined, subsidiary);
  const reference = extractTaskMdPath(session.current_task);
  const owned = tasks.filter((task) => task.frontmatter.working_session_id === input.sessionId
    || (task.path === reference && !task.frontmatter.working_session_id));
  if (!owned.length) return;
  const snapshots: TaskPrEvidence[] = [];
  const observed = (input.now?.() ?? new Date()).toISOString();
  const gh = findSessionPr(input);
  if (gh && normalizeRepoOrigin(gh.repo_origin).toLowerCase() === repository && gh.head_branch === session.branch) {
    snapshots.push({ provider: "github", repository, id: String(gh.number), number: gh.number, url: gh.url,
      head_sha: gh.head_sha ?? null, reviewed_head_sha: null, state: gh.state,
      review: gh.review_state, reflection: "unknown", observed_at: observed });
  }
  const rv = input.revisor ? await findSessionLocalPr({ ...input, revisor: input.revisor }) : null;
  if (rv) snapshots.push({ provider: "revisor", repository, id: rv.id, number: rv.number,
    url: null, head_sha: rv.headSha, reviewed_head_sha: rv.reviewedHeadSha ?? null,
    state: rv.status === "merged" ? "merged" : rv.status === "closed" ? "closed" : rv.draft ? "draft" : "open",
    review: rv.checkStatus, reflection: "unknown", observed_at: observed });
  for (const task of owned) for (const snapshot of snapshots) {
    await input.store.setPrEvidence(task.repoPath, task.path, snapshot, subsidiary);
  }
}
