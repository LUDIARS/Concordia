import type { ConfluxGateResult } from "./conflux-service.js";
import { resolve } from "node:path";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { HarnessAction, PredicateHit } from "../predicates.js";
import { checkSubmittedTask, checkNewBranchCommand, checkRegisteredCheckout, requiresTaskBranchCheck, parseTaskRelation, type SubmittedTask, type TaskRelation } from "./task-branch-policy.js";
import { readBranchSnapshot, type BranchSnapshot } from "./task-branch-git.js";
import { githubSubmission } from "./task-branch-submission.js";

const KEY = "task_branch_submission";
type Store = Pick<SessionsRepo, "findSession" | "mergeMetadata">;

/** Session-owned persisted PR boundary, shared by classifier and deterministic hook. */
export class TaskBranchService {
  constructor(private readonly sessions: Store,
    private readonly inspect: (cwd: string) => Promise<BranchSnapshot> = readBranchSnapshot,
    private readonly conflux?: (id: string, action: HarnessAction) => Promise<ConfluxGateResult>) {}

  read(id: string): SubmittedTask | null {
    const session = this.sessions.findSession(id);
    if (!session) return null;
    const metadata = JSON.parse(session.metadata || "{}") as Record<string, unknown>;
    const raw = metadata[KEY];
    if (raw === undefined) return null;
    if (!raw || typeof raw !== "object") throw new Error("Invalid submitted task boundary");
    const row = raw as Record<string, unknown>;
    if (![row.repo, row.branch, row.task, row.pr].every(value => typeof value === "string")) {
      throw new Error("Invalid submitted task boundary; reconcile the session before editing");
    }
    return { repo: row.repo as string, branch: row.branch as string, task: row.task as string,
      pr: row.pr as string, relation: parseTaskRelation(row.relation),
      version: typeof row.version === "number" ? row.version : 0 };
  }

  submitted(id: string, snapshot: { repo: string; branch: string; task: string }, pr: string): void {
    this.sessions.mergeMetadata(id, { [KEY]: { ...snapshot, repo: resolve(snapshot.repo), pr,
      relation: "unknown", version: (this.read(id)?.version ?? 0) + 1 } });
  }

  observeSubmission(id: string, input: { command?: string; message?: string; failed?: boolean }): void {
    const session = this.sessions.findSession(id);
    if (!session) return;
    const pr = githubSubmission({ ...input, repoOrigin: session.repo_origin, branch: session.branch });
    if (pr && this.read(id)?.pr !== pr) this.submitted(id, {
      repo: session.repo_path, branch: session.branch || "", task: session.current_task || "",
    }, pr);
  }

  beginClassification(id: string): SubmittedTask | null {
    const current = this.read(id);
    if (!current) return null;
    const next: SubmittedTask = { ...current, relation: "unknown", version: current.version + 1 };
    this.sessions.mergeMetadata(id, { [KEY]: next });
    return next;
  }

  classify(id: string, expected: SubmittedTask | null, relation: TaskRelation): void {
    const current = this.read(id);
    // A late classifier result must not overwrite a newer submission.
    if (!current || !expected || current.pr !== expected.pr || current.branch !== expected.branch
      || current.repo !== expected.repo || current.task !== expected.task || current.version !== expected.version) return;
    this.sessions.mergeMetadata(id, { [KEY]: { ...current, relation } });
  }

  async gate(id: string, action: HarnessAction): Promise<PredicateHit | null> {
    const flow = await this.conflux?.(id, action);
    if (flow?.hit) return flow.hit;
    const originHit = checkNewBranchCommand(action.command, flow?.baseBranch);
    if (originHit) return originHit;
    if (!requiresTaskBranchCheck(action)) return null;
    const session = this.sessions.findSession(id);
    if (!session) return { rule: "task-branch", decision: "deny", reason: "作業セッションが不明です。" };
    const registered = { repo: resolve(session.repo_path), branch: session.branch || "" };
    let acting: BranchSnapshot;
    try { acting = await this.inspect(action.cwd || registered.repo); }
    catch { return { rule: "task-branch", decision: "deny", reason: "実ブランチを確認できません。編集前にGitの状態を確認してください。" }; }
    // The registered checkout is read on its own, so a shell parked elsewhere does not decide the boundary.
    const registeredRepo = acting.repo === registered.repo ? acting : await this.inspect(registered.repo).catch(() => null);
    const mismatch = checkRegisteredCheckout({ registered, acting, registeredRepo, tool: action.tool });
    if (mismatch) return mismatch;
    const hit = checkSubmittedTask({ submitted: this.read(id), repo: registered.repo, branch: registered.branch, task: session.current_task || "" });
    if (hit) return hit;
    if (!flow?.active && !(registeredRepo ?? acting).mainExists) return { rule: "task-main-origin", decision: "warn", reason: "ローカルmainがありません。新規作業を別のブランチ起点で作成しないでください。" };
    return null;
  }
}
