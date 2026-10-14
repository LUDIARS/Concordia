/**
 * 拠点の作業記録に載せる「セッションが提出した PR」の対応付け (SPEC-FED-SITE-ACTIVITY)。
 *
 * 2026-10-14 neco「拠点から送る記録に PR を含めます」。 対応は Cc の既存の記録だけから取る:
 * Revisor の local PR は提出元の `sessionId`、 GitHub PR は Cc の PR 記録 (pr_records) の `author_session_id`。
 * 本文・差分・審査理由・CI の詳細は送らない (番号・リポジトリ・題名・状態・URL だけ)。 純関数。
 *
 * @implements SPEC-FED-SITE-ACTIVITY
 */
import { ACTIVITY_SESSION_MAX_PRS, type FederationActivityPr } from "../federation/protocol.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:37f56d19 */
import augurContract_312840ea from './site-activity-prs.contract.js'; /* augur-inject:contract-predicate:5be04f77 */

/** Revisor の local PR のうち、 ここで使う項目だけ (`RevisorLocalPr` の部分集合)。 */
export interface LocalPrSource {
  number: number;
  repository: string;
  title: string;
  status: string;
  sessionId?: string | null;
  updatedAt?: string;
}

/** Cc の PR 記録のうち、 ここで使う項目だけ (`PrRecordRow` の部分集合)。 */
export interface GithubPrSource {
  repo_origin: string;
  number: number;
  title: string;
  url: string | null;
  state: string;
  author_session_id: string | null;
  updated_at: number;
}

function clip(value: string | null | undefined, max: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function toActivityPr(source: FederationActivityPr["source"], repo: string, number: number, title: string, state: string, url: string | null): FederationActivityPr | null {
  const cleanRepo = clip(repo, 200);
  if (!cleanRepo || !Number.isInteger(number) || number <= 0) return null;
  const cleanUrl = clip(url, 300);
  return {
    source,
    repo: cleanRepo,
    number,
    title: clip(title, 150),
    state: clip(state, 30) || "unknown",
    url: cleanUrl && /^https?:\/\//i.test(cleanUrl) ? cleanUrl : null,
  };
}

/**
 * 対象セッションごとに、 そのセッションが提出した PR を新しい順で最大 `limit` 件返す。
 * 対象外のセッション・提出元が分からない PR は載せない。 同じ PR (source・repo・番号) は 1 件にする。
 */
export function indexSessionPrs(
  sessionIds: readonly string[],
  localPrs: readonly LocalPrSource[],
  githubPrs: readonly GithubPrSource[],
  limit: number = ACTIVITY_SESSION_MAX_PRS,
): Map<string, FederationActivityPr[]> {
  const wanted = new Set(sessionIds);
  const candidates = new Map<string, Array<{ at: number; pr: FederationActivityPr }>>();
  const add = (sessionId: string | null | undefined, at: number, pr: FederationActivityPr | null) => {
    if (!sessionId || !wanted.has(sessionId) || !pr) return;
    const list = candidates.get(sessionId) ?? [];
    if (list.some((c) => c.pr.source === pr.source && c.pr.repo === pr.repo && c.pr.number === pr.number)) return;
    list.push({ at, pr });
    candidates.set(sessionId, list);
  };
  for (const pr of localPrs) {
    const at = pr.updatedAt ? Date.parse(pr.updatedAt) / 1000 : 0;
    add(pr.sessionId, Number.isFinite(at) ? at : 0, toActivityPr("local", pr.repository, pr.number, pr.title, pr.status, null));
  }
  for (const pr of githubPrs) {
    add(pr.author_session_id, pr.updated_at, toActivityPr("github", pr.repo_origin, pr.number, pr.title, pr.state, pr.url));
  }
  const out = new Map<string, FederationActivityPr[]>();
  for (const [sessionId, list] of candidates) {
    out.set(sessionId, list.sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit)).map((c) => c.pr));
  }
  return out;
}
// @ts-expect-error augur-inject
indexSessionPrs = contract(indexSessionPrs, { ...augurContract_312840ea, contractId: 'site-activity-prs-C-1', mode: 'observe', sample: 1, where: 'src/daily/site-activity-prs.ts:56', rule: 'contract-wrap', id: '312840ea' }); /* augur-inject:contract-wrap:312840ea */
