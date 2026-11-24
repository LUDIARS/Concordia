/**
 * 週次レビューの対象 (service-map の daily_review: true) ごとに、 ローカル main の HEAD・前回レビューの HEAD・
 * 差分の統計とファイル一覧を読む。 コード本文は読まない (CC-PT-AGENT-INV-03)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 読み取り adapter (週次レビュー)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewChangedFile, ReviewTarget } from "../agent-jobs/ludiars-review-weekly.js";
import type { GitRead } from "./git-read.js";
import type { ServiceMapRepo } from "./service-map.js";

const SHA = /^[0-9a-f]{40}$/u;

/** 純関数: `git diff --numstat` の出力を読む (バイナリは added / deleted が null)。 */
export function parseNumstat(text: string): ReviewChangedFile[] {
  return text.split(/\r?\n/u).flatMap((line): ReviewChangedFile[] => {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/u.exec(line);
    if (!match) return [];
    return [{ added: match[1] === "-" ? null : Number(match[1]), deleted: match[2] === "-" ? null : Number(match[2]), path: match[3]! }];
  });
}

async function previousReview(workspaceRoot: string, repo: string): Promise<{ head: string | null; reviewedAt: string | null }> {
  try {
    const latest = JSON.parse(await readFile(join(workspaceRoot, "Review", repo, "latest.json"), "utf8")) as { head?: unknown; reviewed_at?: unknown };
    return {
      head: typeof latest.head === "string" && SHA.test(latest.head) ? latest.head : null,
      reviewedAt: typeof latest.reviewed_at === "string" ? latest.reviewed_at : null,
    };
  } catch {
    // 初回 (latest.json 無し) は前回なしとして渡す (status: unknown)。
    return { head: null, reviewedAt: null };
  }
}

export async function readReviewTargets(deps: { workspaceRoot: string; repos: ServiceMapRepo[]; git: GitRead }): Promise<ReviewTarget[]> {
  const targets: ReviewTarget[] = [];
  for (const repo of deps.repos.filter((candidate) => candidate.dailyReview)) {
    const repoPath = join(deps.workspaceRoot, repo.name);
    const headRaw = await deps.git(repoPath, ["rev-parse", "--verify", "refs/heads/main"]);
    const head = headRaw && SHA.test(headRaw) ? headRaw : null;
    const previous = await previousReview(deps.workspaceRoot, repo.name);
    let commits: number | null = null;
    let files: ReviewChangedFile[] = [];
    if (head && previous.head && head !== previous.head) {
      const range = `${previous.head}..${head}`;
      const count = await deps.git(repoPath, ["rev-list", "--count", range]);
      commits = count !== null && /^\d+$/u.test(count) ? Number(count) : null;
      files = parseNumstat((await deps.git(repoPath, ["diff", "--numstat", "--no-renames", range])) ?? "");
    } else if (head && previous.head) {
      commits = 0;
    }
    targets.push({ repo: repo.name, code: repo.code, head, previousHead: previous.head, reviewedAt: previous.reviewedAt, commits, files });
  }
  return targets;
}
