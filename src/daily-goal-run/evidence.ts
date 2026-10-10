/**
 * 証跡の収集 (port + adapter)。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 1 時間ごとの確認 (証跡を集める) / CC-DG-INV-03 / CC-DG-INV-08
 *
 * 集めるのは commit (専用セッションの作業 branch)、 PR (Cc の pr_records と Revisor local PR)、
 * Actio task の状態。 Actio へは読み取りだけで書かない。 情報源が読めなかったときは
 * unavailable に残し、 空の成功にしない。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DailyGoal, EvidenceItem, EvidenceSnapshot } from "./domain.js";

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

export function createEvidenceAdapter(deps: EvidenceAdapterDeps): EvidencePort {
  const git = deps.git ?? runGit;
  return {
    async collect(goal, since) {
      const items: EvidenceItem[] = [];
      const unavailable: string[] = [];
      const taskStatuses: Record<string, string> = {};
      const session = goal.sessionId ? deps.session(goal.sessionId) : null;
      if (session?.branch) {
        try {
          const out = await git(session.repo_path, ["log", `--since=@${Math.floor(since / 1000)}`, "--format=%H%x09%ct%x09%s", "-n", "200", session.branch, "--"]);
          items.push(...parseCommitLog(out));
        } catch { unavailable.push("git"); }
      } else if (goal.sessionId) unavailable.push("git");
      if (goal.sessionId) {
        try { items.push(...prEvidence(deps.prsBySession(goal.sessionId), since)); } catch { unavailable.push("pr_records"); }
        if (deps.revisorByBranch && session?.repo_origin && session.branch) {
          try {
            const pr = await deps.revisorByBranch(session.repo_origin, session.branch);
            if (pr) items.push({ key: `revisor:${pr.id}:${pr.status}:${pr.checkStatus}`, kind: "revisor", summary: `local PR #${pr.number} ${pr.status}/${pr.checkStatus}: ${pr.title}`.slice(0, 200), at: Date.parse(pr.updatedAt) || null });
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
