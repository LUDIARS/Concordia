import type { ConfluxGateResult } from "./conflux-service.js";
import { resolve } from "node:path";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { HarnessAction, PredicateHit } from "../predicates.js";
import { checkSubmittedTask, checkNewBranchCommand, checkRegisteredCheckout, deterministicTaskRelation, homeRegistration, homeRestoredNotice, readDeclaredTask, releasesSubmittedBoundary, requiresTaskBranchCheck, parseTaskRelation, type SubmittedPrState, type SubmittedTask, type TaskRelation } from "./task-branch-policy.js";
import { readBranchSnapshot, type BranchSnapshot } from "./task-branch-git.js";
import { githubSubmission } from "./task-branch-submission.js";

const KEY = "task_branch_submission";
/** Registered linked worktree path → its repository's main checkout (TB-HOME). */
const HOME_KEY = "task_branch_home";
type Store = Pick<SessionsRepo, "findSession" | "mergeMetadata" | "restoreCheckoutRegistration">;

function readHomeRecord(metadata: string | null): Record<string, string> | null {
  try {
    const raw = (JSON.parse(metadata || "{}") as Record<string, unknown>)[HOME_KEY];
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, string> : null;
  } catch { return null; }
}

/** Session-owned persisted PR boundary, shared by classifier and deterministic hook. */
export class TaskBranchService {
  constructor(private readonly sessions: Store,
    private readonly inspect: (cwd: string) => Promise<BranchSnapshot> = readBranchSnapshot,
    private readonly conflux?: (id: string, action: HarnessAction) => Promise<ConfluxGateResult>,
    private readonly submittedPrState?: (pr: string) => Promise<SubmittedPrState>) {}

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
      version: typeof row.version === "number" ? row.version : 0,
      ...(row.declared === true ? { declared: true } : {}),
      ...(typeof row.label === "string" && row.label ? { label: row.label } : {}) };
  }

  /**
   * 提出を記録する。 task は宣言タスク (declared_task) を優先し、無ければ current_task を旧形式として
   * 残す (declared=false)。 label は PR の表示名。
   */
  submitted(id: string, snapshot: { repo: string; branch: string; label?: string | null }, pr: string): void {
    const session = this.sessions.findSession(id);
    const declared = session ? readDeclaredTask(session) : null;
    this.sessions.mergeMetadata(id, { [KEY]: {
      repo: resolve(snapshot.repo), branch: snapshot.branch,
      task: declared ?? session?.current_task ?? "", declared: declared !== null,
      ...(snapshot.label ? { label: snapshot.label } : {}),
      pr, relation: "unknown", version: (this.read(id)?.version ?? 0) + 1 } });
  }

  observeSubmission(id: string, input: { command?: string; message?: string; failed?: boolean }): void {
    const session = this.sessions.findSession(id);
    if (!session) return;
    const pr = githubSubmission({ ...input, repoOrigin: session.repo_origin, branch: session.branch });
    if (pr && this.read(id)?.pr !== pr) this.submitted(id, {
      repo: session.repo_path, branch: session.branch || "", label: pr,
    }, pr);
  }

  /**
   * 新しい指示ごとに分類をやり直す。 指示が提出済み PR を番号か branch で直接指していれば
   * その場で same-task を確定し (LLM を待たない)、 `decided` を返す。
   */
  beginClassification(id: string, prompt?: string): (SubmittedTask & { decided?: boolean }) | null {
    const current = this.read(id);
    if (!current) return null;
    const decided = prompt ? deterministicTaskRelation(prompt, current) : null;
    const next: SubmittedTask = { ...current, relation: decided ?? "unknown", version: current.version + 1 };
    this.sessions.mergeMetadata(id, { [KEY]: next });
    return decided ? { ...next, decided: true } : next;
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
    let registered = { repo: resolve(session.repo_path), branch: session.branch || "" };
    let acting: BranchSnapshot;
    try { acting = await this.inspect(action.cwd || registered.repo); }
    catch { return { rule: "task-branch", decision: "deny", reason: "実ブランチを確認できません。編集前にGitの状態を確認してください。" }; }
    // The registered checkout is read on its own, so a shell parked elsewhere does not decide the boundary.
    let registeredRepo = acting.repo === registered.repo ? acting : await this.inspect(registered.repo).catch(() => null);
    this.rememberHome(id, session.metadata, registered.repo, registeredRepo);
    const mismatch = checkRegisteredCheckout({ registered, acting, registeredRepo, tool: action.tool });
    let notice: PredicateHit | null = null;
    if (mismatch) {
      const restored = await this.restoreHome(id, session, registered, acting, registeredRepo);
      if (!restored) return mismatch;
      notice = homeRestoredNotice(registered, restored);
      registered = restored;
      registeredRepo = acting.repo === restored.repo ? acting : await this.inspect(restored.repo).catch(() => null);
      if (checkRegisteredCheckout({ registered, acting, registeredRepo, tool: action.tool })) return { ...mismatch, reason: `${notice.reason} ${mismatch.reason}` };
    }
    const submitted = this.read(id);
    const hit = checkSubmittedTask({ submitted, repo: registered.repo, branch: registered.branch,
      task: readDeclaredTask(session) ?? session.current_task ?? "" });
    if (hit && !(await this.releaseMerged(id, submitted))) return hit;
    if (!flow?.active && !(registeredRepo ?? acting).mainExists) return { rule: "task-main-origin", decision: "warn", reason: "ローカルmainがありません。新規作業を別のブランチ起点で作成しないでください。" };
    return notice;
  }

  /**
   * TB-HOME: a deleted worktree cannot name its repository, so its main checkout is remembered while it
   * is still readable. Written only when it changes.
   */
  private rememberHome(id: string, metadata: string | null, registeredPath: string, registeredRepo: BranchSnapshot | null): void {
    const home = registeredRepo?.checkouts?.[0]?.repo;
    if (!home || home === registeredPath) return;
    if (readHomeRecord(metadata)?.[registeredPath] === home) return;
    this.sessions.mergeMetadata(id, { [HOME_KEY]: { [registeredPath]: home } });
  }

  /** TB-HOME: rebinds only when the policy finds the registered work finished; returns the new registration. */
  private async restoreHome(id: string, session: { repo_path: string; branch: string | null; metadata: string | null },
    registered: { repo: string; branch: string }, acting: BranchSnapshot, registeredRepo: BranchSnapshot | null,
  ): Promise<{ repo: string; branch: string } | null> {
    const homePath = registeredRepo?.checkouts?.[0]?.repo
      ?? (acting.checkouts?.some(checkout => checkout.repo === registered.repo) ? acting.checkouts?.[0]?.repo : undefined)
      ?? readHomeRecord(session.metadata)?.[registered.repo];
    if (!homePath) return null;
    const home = homePath === acting.repo ? acting : await this.inspect(homePath).catch(() => null);
    const submitted = this.read(id);
    const ownBoundary = submitted && submitted.repo === registered.repo && submitted.branch === registered.branch;
    const candidate = (merged: boolean) => homeRegistration({ registered, registeredRepo, acting, home, merged });
    let next = candidate(false);
    // The PR state is read only when nothing else releases the registration.
    if (!next && ownBoundary && this.submittedPrState && home && acting.repo === home.repo) {
      next = candidate(releasesSubmittedBoundary(await this.submittedPrState(submitted.pr)));
    }
    if (!next) return null;
    const moved = this.sessions.restoreCheckoutRegistration({ id,
      expected: { repo_path: session.repo_path, branch: session.branch },
      next: { repo_path: next.repo, branch: next.branch }, ts: Date.now() });
    return moved ? next : null;
  }

  /**
   * TB-MERGED: 境界の PR が正本でマージ済みなら境界を外す。照会は拒否する直前だけ行い、
   * 確認できなければ外さない。照会中に別の PR が提出されていたら、その新しい境界は残す。
   */
  private async releaseMerged(id: string, submitted: SubmittedTask | null): Promise<boolean> {
    if (!submitted || !this.submittedPrState) return false;
    if (!releasesSubmittedBoundary(await this.submittedPrState(submitted.pr))) return false;
    const current = this.read(id);
    if (!current || current.pr !== submitted.pr || current.repo !== submitted.repo || current.branch !== submitted.branch) return false;
    this.sessions.mergeMetadata(id, { [KEY]: null });
    return true;
  }
}
