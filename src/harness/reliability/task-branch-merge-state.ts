import type { PrRecordsRepo } from "../../db/pr-records-repo.js";
import { normalizeRepoOrigin } from "../../pr/normalize.js";
import type { RevisorLocalPrReader } from "../../pr/revisor-client.js";
import { findLocalPrById } from "../../pr/revisor-merge-confirm.js";
import type { SubmittedPrState } from "./task-branch-policy.js";

/** 照会でゲートの応答を待たせない上限。超えたら確認できなかった扱いにする (fail-closed)。 */
const READ_TIMEOUT_MS = 3_000;

export interface SubmittedPrStateDeps {
  revisor?: Pick<RevisorLocalPrReader, "listLocalPrs">;
  prs?: Pick<PrRecordsRepo, "findByKey">;
  timeoutMs?: number;
}

/**
 * 提出境界に記録した PR 参照から、正本 (Revisor の local PR / GitHub を反映した pr_records) の
 * 状態を読む adapter。参照の形は記録元ごとに 3 つある: Revisor local PR の id (local PR 提出)、
 * GitHub PR の URL (`gh pr create`)、`<owner>/<repo>#<number>` (stat 取り込み)。
 */
export function submittedPrStateReader(deps: SubmittedPrStateDeps): (pr: string) => Promise<SubmittedPrState> {
  const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS;
  return (pr) => withTimeout(readState(deps, pr), timeoutMs);
}

async function readState(deps: SubmittedPrStateDeps, pr: string): Promise<SubmittedPrState> {
  const github = parseGithubPr(pr);
  if (github) {
    const row = deps.prs?.findByKey(github.repoOrigin, github.number);
    if (!row) return "unknown";
    return row.state === "merged" ? "merged" : "unmerged";
  }
  if (!deps.revisor) return "unknown";
  // findLocalPrById は読み取り失敗と不在を区別せず null を返す。どちらも確認できない扱い。
  const local = await findLocalPrById(deps.revisor, pr);
  if (!local) return "unknown";
  return local.status === "merged" ? "merged" : "unmerged";
}

function parseGithubPr(pr: string): { repoOrigin: string; number: number } | null {
  const url = pr.match(/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  if (url) return { repoOrigin: normalizeRepoOrigin(url[1]!), number: Number(url[2]) };
  const short = pr.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (short) return { repoOrigin: short[1]!, number: Number(short[2]) };
  return null;
}

async function withTimeout(read: Promise<SubmittedPrState>, timeoutMs: number): Promise<SubmittedPrState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SubmittedPrState>((resolveState) => {
    timer = setTimeout(() => resolveState("unknown"), timeoutMs);
  });
  try {
    return await Promise.race([read.catch((): SubmittedPrState => "unknown"), expired]);
  } finally {
    clearTimeout(timer);
  }
}
