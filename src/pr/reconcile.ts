/**
 * PR reconcile tick (取り込み方式 C — GitHub 状態同期).
 *
 * pr_records に open/draft 行を持つ repo_origin について `gh pr list --state all` を
 * 引き、 merged/closed/ci/review/サイズを既存行に反映する (新規 insert はしない).
 * stat 派生 (ingest.ts) が拾えない「マージ後の状態遷移」 を確定するのが役割.
 *
 * - 無効化: env CONCORDIA_PR_RECONCILE_ENABLED=0
 * - 間隔:   env CONCORDIA_PR_RECONCILE_MIN (分, 既定 10, 下限 2)
 * - gh が無い / 認証切れ等は best-effort (warn ログのみ、 サービスは落とさない).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PrCiStatus,
  PrRecordRow,
  PrRecordsRepo,
  PrReviewState,
  PrState,
} from "../db/pr-records-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import { isOwnerRepo, normalizeRepoOrigin, prUrlFor } from "./normalize.js";
import type { RevisorReviewTrigger } from "./revisor-client.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";

const execFileAsync = promisify(execFile);
const log = createChildLogger("pr-reconcile");

const GH_BIN = process.platform === "win32" ? "gh.exe" : "gh";
const REVISOR_CHECK_NAME = "Revisor review";
const REVISOR_AUTOFIX_TRAILER = /^Revisor-Autofix:\s*true\s*$/im;
const GH_FIELDS =
  "number,title,url,state,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,mergedAt,closedAt,isDraft,isCrossRepository";

interface GhPr {
  number: number;
  title?: string;
  url?: string;
  state?: string; // OPEN | CLOSED | MERGED
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewDecision?: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }>;
  mergedAt?: string | null;
  closedAt?: string | null;
  isDraft?: boolean;
  isCrossRepository?: boolean;
}

export interface PrReconcileDeps {
  prs: PrRecordsRepo;
  sessions: SessionsRepo;
  tasks?: TasksRepo;
  revisor?: RevisorReviewTrigger;
  isCcWorkflowEnabled?: () => boolean;
  resolveReviewMode?: (
    origin: string,
    headSha: string,
  ) => Promise<"full" | "verification">;
  fetchPrsForOrigin?: (origin: string) => Promise<GhPr[]>;
  nowSec?: () => number;
  /**
   * base=develop の PR が merged になっているのを観測したときの通知先 (確認フローの入口)。
   * 同じ merge を毎周期観測するので **冪等な実装** であること。
   * spec/feature/develop-confirm-flow.md §5。
   */
  onDevelopMerge?: (event: {
    repo_origin: string;
    pr_number: number;
    pr_title: string;
    pr_url: string | null;
  }) => void | Promise<void>;
}

export interface PrReconcileHandle {
  stop: () => void;
  /** テスト/手動用: 1 回だけ走らせる. */
  runOnce: () => Promise<{ scanned: number; updated: number }>;
}

function isoToSec(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function mapState(gh: GhPr): PrState {
  const s = (gh.state ?? "").toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  if (gh.isDraft) return "draft";
  return "open";
}

function mapCi(gh: GhPr): PrCiStatus {
  const checks = gh.statusCheckRollup;
  if (!Array.isArray(checks) || checks.length === 0) return "unknown";
  let pending = false;
  for (const c of checks) {
    const concl = (c.conclusion ?? "").toUpperCase();
    const status = (c.status ?? "").toUpperCase();
    const state = (c.state ?? "").toUpperCase();
    if (concl === "FAILURE" || concl === "TIMED_OUT" || concl === "CANCELLED" || state === "FAILURE" || state === "ERROR") {
      return "failure";
    }
    if (status !== "COMPLETED" && state !== "SUCCESS" && concl === "") pending = true;
  }
  return pending ? "pending" : "success";
}

function mapReview(gh: GhPr): PrReviewState | undefined {
  switch ((gh.reviewDecision ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "needs_review";
    default:
      return undefined; // 不明: 既存値を上書きしない
  }
}

function hasRevisorCheck(gh: GhPr): boolean {
  return gh.statusCheckRollup?.some((check) =>
    check.name === REVISOR_CHECK_NAME || check.context === REVISOR_CHECK_NAME
  ) ?? false;
}

export function reviewModeFromCommitMessage(
  message: string,
): "full" | "verification" {
  return REVISOR_AUTOFIX_TRAILER.test(message) ? "verification" : "full";
}

async function fetchPrsForOrigin(origin: string): Promise<GhPr[]> {
  const { stdout } = await execFileAsync(
    GH_BIN,
    ["pr", "list", "--repo", origin, "--state", "all", "--limit", "100", "--json", GH_FIELDS],
    { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? (parsed as GhPr[]) : [];
}

async function resolveOriginFromRepoPath(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "git.exe" : "git",
      ["-C", repoPath, "remote", "get-url", "origin"],
      { timeout: 8_000, windowsHide: true },
    );
    const origin = normalizeRepoOrigin(stdout.trim());
    return isOwnerRepo(origin) ? origin : null;
  } catch {
    return null;
  }
}

async function resolveReviewMode(
  origin: string,
  headSha: string,
): Promise<"full" | "verification"> {
  const { stdout } = await execFileAsync(
    GH_BIN,
    ["api", `repos/${origin}/commits/${headSha}`, "--jq", ".commit.message"],
    { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  return reviewModeFromCommitMessage(stdout);
}

async function enqueueRevisorReview(
  deps: PrReconcileDeps,
  existing: PrRecordRow | null,
  origin: string,
  gh: GhPr,
  ciStatus: PrCiStatus,
): Promise<void> {
  if (
    !deps.revisor
    || !(deps.isCcWorkflowEnabled?.() ?? false)
    || !existing?.author_session_id
    || mapState(gh) !== "open"
    || gh.isCrossRepository !== false
    || ciStatus !== "success"
    || hasRevisorCheck(gh)
    || !gh.headRefOid
    || !gh.headRefName
    || !gh.baseRefName
  ) {
    return;
  }

  try {
    const reviewMode = await (deps.resolveReviewMode ?? resolveReviewMode)(
      origin,
      gh.headRefOid,
    );
    const job = await deps.revisor.enqueue({
      repository: origin,
      number: gh.number,
      head_sha: gh.headRefOid,
      head_ref: gh.headRefName,
      head_repository: origin,
      base_ref: gh.baseRefName,
      pull_request_url: gh.url ?? existing.url ?? prUrlFor(origin, gh.number) ?? undefined,
      review_mode: reviewMode,
    });
    log.info({
      repo_origin: origin,
      pr_number: gh.number,
      head_sha: gh.headRefOid,
      revisor_job_id: job.id,
      revisor_status: job.status,
    }, "Cc workflow enqueued Revisor review");
  } catch (e) {
    log.warn({
      repo_origin: origin,
      pr_number: gh.number,
      head_sha: gh.headRefOid,
      err: (e as Error).message,
    }, "Cc workflow could not enqueue Revisor review");
  }
}

export function startPrReconciler(deps: PrReconcileDeps): PrReconcileHandle {
  const enabled = process.env.CONCORDIA_PR_RECONCILE_ENABLED !== "0";
  const minutes = Math.max(2, Number(process.env.CONCORDIA_PR_RECONCILE_MIN ?? "10") || 10);
  const now = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  async function runOnce(): Promise<{ scanned: number; updated: number }> {
    if (!enabled) return { scanned: 0, updated: 0 };
    const origins = new Set<string>(deps.prs.distinctActiveOrigins().filter(isOwnerRepo));
    const activeSessions = deps.sessions.listSessions({ status: "active" });
    for (const s of activeSessions) {
      const byMeta = normalizeRepoOrigin(s.repo_origin ?? "");
      if (isOwnerRepo(byMeta)) {
        origins.add(byMeta);
        continue;
      }
      const byPath = await resolveOriginFromRepoPath(s.repo_path);
      if (byPath) origins.add(byPath);
    }
    let scanned = 0;
    let updated = 0;
    for (const origin of origins.values()) {
      let list: GhPr[];
      try {
        list = await (deps.fetchPrsForOrigin ?? fetchPrsForOrigin)(origin);
      } catch (e) {
        log.warn(`gh pr list failed for ${origin}: ${(e as Error).message}`);
        continue;
      }
      for (const gh of list) {
        scanned += 1;
        let existing = deps.prs.findByKey(origin, gh.number);
        if (!existing) {
          deps.prs.upsertFromStat({
            repo_origin: origin,
            number: gh.number,
            title: gh.title ?? "",
            url: gh.url ?? prUrlFor(origin, gh.number),
            head_branch: gh.headRefName ?? null,
            base_branch: gh.baseRefName ?? null,
            repo_path: null,
            author_session_id: null,
            persona_id: null,
            persona_name: null,
          });
          existing = deps.prs.findByKey(origin, gh.number);
        }
        const nextCi = mapCi(gh);
        await enqueueRevisorReview(deps, existing, origin, gh, nextCi);
        const changed = deps.prs.reconcile({
          repo_origin: origin,
          number: gh.number,
          title: gh.title,
          url: gh.url,
          head_branch: gh.headRefName ?? null,
          head_sha: gh.headRefOid ?? null,
          base_branch: gh.baseRefName ?? null,
          state: mapState(gh),
          ci_status: nextCi,
          review_state: mapReview(gh),
          additions: gh.additions ?? null,
          deletions: gh.deletions ?? null,
          changed_files: gh.changedFiles ?? null,
          merged_at: isoToSec(gh.mergedAt),
          closed_at: isoToSec(gh.closedAt),
        });
        enqueueCiFollowup(deps, existing, {
          repo_origin: origin,
          number: gh.number,
          title: gh.title ?? existing?.title ?? "",
          url: gh.url ?? existing?.url ?? prUrlFor(origin, gh.number),
          previous_ci_status: existing?.ci_status ?? "unknown",
          ci_status: nextCi,
          nowSec: now(),
        });
        // develop に入った変更は確認待ちに積む。 「今回初めて merged を観測した」に絞らず
        // 毎回投げる — 通知先が冪等なので、 Concordia の再起動を跨いでも取りこぼさない方を採る。
        if (mapState(gh) === "merged" && gh.baseRefName === "develop" && deps.onDevelopMerge) {
          void Promise.resolve(
            deps.onDevelopMerge({
              repo_origin: origin,
              pr_number: gh.number,
              pr_title: gh.title ?? existing?.title ?? "",
              pr_url: gh.url ?? existing?.url ?? prUrlFor(origin, gh.number),
            }),
          ).catch((e) => log.warn(`develop merge intake failed: ${(e as Error).message}`));
        }
        if (changed) updated += 1;
      }
    }
    if (updated > 0) {
      eventBus.emit({ type: "pr.changed", reason: "reconcile", ts: Math.floor(Date.now() / 1000) });
    }
    return { scanned, updated };
  }

  let supervised: SupervisedIntervalHandle | null = null;
  if (enabled) {
    // 起動直後に 1 回 + 以降 interval. backend boot を遅らせないため初回は遅延実行.
    supervised = startSupervisedInterval("pr-reconcile", async () => {
      const r = await runOnce();
      log.info(`reconcile: scanned=${r.scanned} updated=${r.updated}`);
    }, {
      intervalMs: minutes * 60 * 1000,
      initialDelayMs: 15_000,
      log: { warn: (message) => log.warn(message) },
    });
  } else {
    log.info("CONCORDIA_PR_RECONCILE_ENABLED=0; reconcile disabled");
  }

  return {
    stop: () => {
      supervised?.stop();
      supervised = null;
    },
    runOnce,
  };
}

function enqueueCiFollowup(
  deps: PrReconcileDeps,
  existing: { author_session_id: string | null; ci_status: PrCiStatus } | null,
  pr: {
    repo_origin: string;
    number: number;
    title: string;
    url: string | null;
    previous_ci_status: PrCiStatus;
    ci_status: PrCiStatus;
    nowSec: number;
  },
): void {
  if (!deps.tasks) return;
  if (!existing?.author_session_id) return;
  if (pr.previous_ci_status === pr.ci_status) return;
  if (pr.ci_status !== "success" && pr.ci_status !== "failure") return;
  const instructions = pr.ci_status === "success"
    ? "PR CI is green. Report the status and stop. Do not run tests or merge unless the user explicitly requests it."
    : "PR CI is red. Report the failing status and stop. Inspect or fix CI only when the user explicitly requests it.";
  deps.tasks.enqueue({
    session_id: existing.author_session_id,
    kind: "pr-ci-followup",
    now: pr.nowSec,
    payload: {
      repo_origin: pr.repo_origin,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      ci_status: pr.ci_status,
      instructions,
    },
  });
}
