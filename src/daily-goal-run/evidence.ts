/**
 * 証跡の収集 (port + adapter)。
 *
 * @implements spec/feature/daily-goal-run.md — 4. 1 時間ごとのワンショット確認 (証跡を集める) / CC-DG-INV-03 / CC-DG-INV-08
 *
 * 集めるのは commit、 PR (Cc の pr_records と Revisor local PR)、 Actio task の状態。
 * 新方式ではゴールのプロジェクトの repo 単位で集める (commit はローカル branch 全体、 PR は repo origin)。
 * 旧方式で専用セッションが紐付いたゴールだけ、 そのセッションの branch と PR から集める。
 * Actio へは読み取りだけで書かない。 情報源が読めなかったときは unavailable に残し、 空の成功にしない。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSpawnBranch } from "../control/spawn-target.js";
import type { DailyGoal, EvidenceItem, EvidenceSnapshot } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:a65ddcaa */
import augurContract_38dc75bb from './evidence-git-args.contract.js'; /* augur-inject:contract-predicate:5eed0e14 */

export interface EvidencePort {
  /** since (epoch ms) 以降の証跡を累積で返す。 */
  collect(goal: DailyGoal, since: number): Promise<EvidenceSnapshot>;
}

export interface EvidenceSession { repo_path: string; repo_origin: string | null; branch: string | null }
export interface EvidencePr { repo_origin: string; number: number; state: string; review_state: string; updated_at: number; title: string }
export interface EvidenceRevisorPr { id: string; number: number; status: string; checkStatus: string; title: string; updatedAt: string }

export interface EvidenceAdapterDeps {
  session(sessionId: string): EvidenceSession | null;
  prsBySession(sessionId: string): EvidencePr[];
  revisorByBranch?(repository: string, branch: string): Promise<EvidenceRevisorPr | null>;
  /** プロジェクトの repo (repoPath) の origin (owner/repo)。 未登録なら null。 */
  repoOrigin?(repoPath: string): string | null;
  prsByRepo?(repoOrigin: string): EvidencePr[];
  /** Revisor local PR のうち、 その repository のもの。 */
  revisorByRepository?(repository: string): Promise<EvidenceRevisorPr[]>;
  taskStatus(repoPath: string, reference: string): Promise<{ status: string } | null>;
  /** `git -C <cwd> <args>` を実行して stdout を返す。 省略時は git 実行ファイルをタイムアウト付きで呼ぶ。 */
  git?(cwd: string, args: readonly string[]): Promise<string>;
}

const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const GIT_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout;
}

/** `git log --format=%H%x09%ct%x09%s` の出力を commit 証跡に直す (純関数)。 */
export function parseCommitLog(stdout: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [sha, ts, ...subject] = line.split("\t");
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) continue;
    const at = Number(ts) * 1000;
    items.push({ key: `commit:${sha.trim()}`, kind: "commit", summary: subject.join("\t").trim().slice(0, 200), at: Number.isFinite(at) ? at : null });
  }
  return items;
}

/** PR 行を証跡に直す。 状態・審査状態が変わるとキーが変わり、 新しい証跡として数えられる (純関数)。 */
export function prEvidence(prs: readonly EvidencePr[], since: number): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const pr of prs) {
    if (pr.updated_at * (pr.updated_at < 1e12 ? 1000 : 1) < since) continue;
    const base = `pr:${pr.repo_origin}#${pr.number}`;
    items.push({ key: `${base}:${pr.state}`, kind: "pr", summary: `PR #${pr.number} ${pr.state}: ${pr.title}`.slice(0, 200), at: null });
    if (pr.review_state && pr.review_state !== "none") {
      items.push({ key: `${base}:review:${pr.review_state}`, kind: "pr", summary: `PR #${pr.number} 審査 ${pr.review_state}`, at: null });
    }
  }
  return items;
}

/** Validate the stored branch before constructing a read-only Git revision argument. */
export function evidenceGitArgs(branch: string, since: number): string[] | null {
  const parsed = parseSpawnBranch(branch);
  if (!parsed.ok || !parsed.branch || parsed.branch !== branch
    || branch.split("/").some((part) => part.startsWith("."))) return null;
  return ["log", "--since=@" + Math.floor(since / 1000), "--format=%H%x09%ct%x09%s", "-n", "200", "--end-of-options", branch, "--"];
}
// @ts-expect-error augur-inject
evidenceGitArgs = contract(evidenceGitArgs, { ...augurContract_38dc75bb, contractId: 'C-17', mode: 'observe', sample: 1, where: 'src/daily-goal-run/evidence.ts:70', rule: 'contract-wrap', id: '38dc75bb' }); /* augur-inject:contract-wrap:38dc75bb */

/** repo のローカル branch 全体から since 以降の commit を読む引数 (ref 名を外から受けない)。 */
export function repoEvidenceGitArgs(since: number): string[] {
  return ["log", "--branches", "--since=@" + Math.floor(since / 1000), "--format=%H%x09%ct%x09%s", "-n", "200", "--"];
}

function revisorEvidence(pr: EvidenceRevisorPr): EvidenceItem {
  return { key: `revisor:${pr.id}:${pr.status}:${pr.checkStatus}`, kind: "revisor", summary: `local PR #${pr.number} ${pr.status}/${pr.checkStatus}: ${pr.title}`.slice(0, 200), at: Date.parse(pr.updatedAt) || null };
}

export function createEvidenceAdapter(deps: EvidenceAdapterDeps): EvidencePort {
  const git = deps.git ?? runGit;
  /** 新方式: プロジェクトの repo 単位で commit / PR を集める。 */
  const collectRepo = async (goal: DailyGoal, since: number, items: EvidenceItem[], unavailable: string[]): Promise<void> => {
    try { items.push(...parseCommitLog(await git(goal.repoPath, repoEvidenceGitArgs(since)))); }
    catch { unavailable.push("git"); }
    let origin: string | null = null;
    try { origin = deps.repoOrigin?.(goal.repoPath) ?? null; } catch { /* treated as unknown origin below */ }
    if (!origin) { unavailable.push("pr_records"); return; }
    try { items.push(...prEvidence(deps.prsByRepo?.(origin) ?? [], since)); } catch { unavailable.push("pr_records"); }
    if (!deps.revisorByRepository) return;
    try {
      for (const pr of await deps.revisorByRepository(origin)) {
        if ((Date.parse(pr.updatedAt) || 0) >= since) items.push(revisorEvidence(pr));
      }
    } catch { unavailable.push("revisor"); }
  };
  return {
    async collect(goal, since) {
      const items: EvidenceItem[] = [];
      const unavailable: string[] = [];
      const taskStatuses: Record<string, string> = {};
      if (!goal.sessionId) await collectRepo(goal, since, items, unavailable);
      const session = goal.sessionId ? deps.session(goal.sessionId) : null;
      if (session?.branch) {
        try {
          const args = evidenceGitArgs(session.branch, since);
          if (!args) throw new Error("Invalid evidence branch");
          const out = await git(session.repo_path, args);
          items.push(...parseCommitLog(out));
        } catch { unavailable.push("git"); }
      } else if (goal.sessionId) unavailable.push("git");
      if (goal.sessionId) {
        try { items.push(...prEvidence(deps.prsBySession(goal.sessionId), since)); } catch { unavailable.push("pr_records"); }
        if (deps.revisorByBranch && session?.repo_origin && session.branch) {
          try {
            const pr = await deps.revisorByBranch(session.repo_origin, session.branch);
            if (pr) items.push(revisorEvidence(pr));
          } catch { unavailable.push("revisor"); }
        }
      }
      for (const taskId of goal.actioTaskIds) {
        try {
          const task = await deps.taskStatus(goal.repoPath, `actio:${taskId}`);
          const status = task?.status ?? "unknown";
          taskStatuses[taskId] = status;
          if (status === "done" || status === "cancelled") items.push({ key: `actio:${taskId}:${status}`, kind: "actio", summary: `Actio task ${taskId} ${status}`, at: null });
        } catch {
          taskStatuses[taskId] = "unknown";
          if (!unavailable.includes("actio")) unavailable.push("actio");
        }
      }
      return { items: dedupe(items), taskStatuses, unavailable };
    },
  };
}

function dedupe(items: EvidenceItem[]): EvidenceItem[] {
  return [...new Map(items.map((item) => [item.key, item])).values()];
}
