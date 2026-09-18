import { resolve } from "node:path";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { ProjectCodesRepo } from "../../db/project-codes-repo.js";
import type { HarnessAction, PredicateHit } from "../predicates.js";
import { requiresTaskBranchCheck } from "./task-branch-policy.js";
import { parseConfluxSelection, confluxDenied, switchObstacle } from "./conflux-policy.js";
import { inspectConfluxGit, switchConfluxGit } from "./conflux-git.js";
import { EXPLICIT_WORKING_BRANCH_METADATA_KEY } from "../../control/session-work-policy.js";
const KEY = "conflux_selection";
const pathKey = (p: string): string => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
export interface ConfluxGateResult { active: boolean; baseBranch?: string; hit: PredicateHit | null }
/** Owns selection and serializes transitions; Git and DB are adapters. */
export class ConfluxService {
  private readonly pending = new Set<string>();
  constructor(private readonly sessions: SessionsRepo, private readonly projects: ProjectCodesRepo,
    private readonly inspect = inspectConfluxGit, private readonly switchBranch = switchConfluxGit) {}
  private project(id: string) {
    const s = this.sessions.findSession(id);
    return s?.repo_origin ? this.projects.findByRepoOrigin(s.repo_origin) : s ? this.projects.findByRepoPath(s.repo_path) : null;
  }
  select(id: string, value: unknown): void {
    const selection = parseConfluxSelection(value);
    const project = this.project(id);
    if (!selection || project?.conflux_flow !== 1 || project.code !== selection.projectCode) throw new Error("有効なCfプロジェクトと流れを指定してください。");
    const session = this.sessions.findSession(id)!;
    if (this.pending.has(pathKey(session.repo_path))) throw new Error("ブランチ照合中です。再試行してください。");
    this.sessions.mergeMetadata(id, { [KEY]: selection });
  }
  async gate(id: string, action: HarnessAction): Promise<ConfluxGateResult> {
    const project = this.project(id);
    if (project?.conflux_flow !== 1) return { active: false, hit: null };
    const session = this.sessions.findSession(id)!;
    let selection;
    try { selection = parseConfluxSelection(JSON.parse(session.metadata || "{}")[KEY]); } catch { selection = null; }
    const denied = (reason: string): ConfluxGateResult => ({ active: true, hit: confluxDenied(reason) });
    if (!selection || selection.projectCode !== project.code) {
      return requiresTaskBranchCheck(action) ? denied("Cfの潮流・亜流・本流・作業ブランチを選択してください。") : { active: true, hit: null };
    }
    if (!requiresTaskBranchCheck(action)) return { active: true, baseBranch: selection.baseBranch, hit: null };
    const key = pathKey(session.repo_path);
    if (this.pending.has(key)) return denied("同じworktreeのブランチ照合中です。再試行してください。");
    this.pending.add(key);
    try {
      const state = await this.inspect(action.cwd || session.repo_path, selection);
      if (pathKey(state.repo) !== key) return denied("作業対象が登録worktreeと一致しません。");
      if (!state.baseExists || (state.workExists && !state.descends)) return denied("選択した本流が存在しないか、作業ブランチが本流を継承していません。");
      if (state.branch === selection.workBranch && session.branch === state.branch) return { active: true, baseBranch: selection.baseBranch, hit: null };
      const peers = this.sessions.findAllActive().some(s => s.id !== id && pathKey(s.repo_path) === key);
      const obstacle = switchObstacle({ ...state, peers });
      if (obstacle) return denied(obstacle);
      await this.switchBranch(state.repo, selection, state.workExists);
      const after = await this.inspect(state.repo, selection);
      if (after.branch !== selection.workBranch || !after.descends) return denied("切替結果を確認できません。Gitの状態を確認してください。");
      this.sessions.patchSession(id, { branch: after.branch });
      this.sessions.mergeMetadata(id, { [EXPLICIT_WORKING_BRANCH_METADATA_KEY]: after.branch });
      return denied("潮流の不一致を検知し " + after.branch + " へ切り替えました。編集内容を新しい状態で確認して再試行してください。");
    } catch { return denied("Cfブランチを照合・切替できません。他worktreeの使用状況とGitの状態を確認してください。"); }
    finally { this.pending.delete(key); }
  }
}
