/**
 * 登録 checkout を前進させてよいかの判定 (純関数)。
 *
 * Revisor はマージ済み main を登録 checkout へ fast-forward で降ろすが、 「いまその
 * checkout を誰が掴んでいるか」 を知らない。 session claim と testing claim を持つのは
 * Concordia だけなので、 可否は Cc が返す (Revisor `spec/feature/checkout-publication.md` §3、
 * Cc `spec/feature/checkout-lock-api.md`)。
 *
 * ここは DB も HTTP も触らない。 呼び出し側 (src/api/checkouts.ts) が active session と
 * active な testing claim を渡す。 **claim は取らない** — 照会で claim を取ると Revisor 側の
 * 中止経路 (§2 の各条件で abort) で解放漏れが起きる。
 */

import { conflictRepoKey, normalizeRepoKey } from "../control/conflict-scope.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import type { SessionRow } from "../shared/types.js";
import type { TestClaimRow } from "../db/testing-claims-repo.js";
import { repoDirNameOf, repoNameOf } from "./origin-identity.js";

/** 拒否理由 (機械可読な短い識別子)。 理由の無い拒否は返さない。 */
export type CheckoutLockReason =
  | "session_active"
  | "testing_claim_active"
  | "branch_in_use";

export type HolderKind = "session" | "testing_claim";

/** 人が次の手を決められるだけの情報を載せる (誰が / 何を / いつから)。 */
export interface CheckoutLockHolder {
  kind: HolderKind;
  session_id: string;
  /** session.current_task。 未設定なら null。 */
  task: string | null;
  branch: string | null;
  repo_path: string | null;
  /** testing claim のときだけ: 対象サービス名と note。 */
  service?: string;
  note?: string;
  since: number;
}

export interface CheckoutLockQuery {
  repo_origin: string;
  repo_path: string;
  branch: string;
}

export interface CheckoutLockInput {
  query: CheckoutLockQuery;
  sessions: readonly SessionRow[];
  /**
   * TTL 内 & 未 release の claim だけを渡すこと (`TestingClaimsRepo.listActive(now)`)。
   * ここでは時刻を持たないので失効判定はしない — 期限切れを混ぜると掴み手が居ないのに
   * 降ろせない状態になる。
   */
  claims: readonly TestClaimRow[];
  workspaceRoots: readonly string[];
}

export type CheckoutLockResult =
  | { allowed: true }
  | { allowed: false; reason: CheckoutLockReason; holders: CheckoutLockHolder[] };

/**
 * 判定。 拒否条件は 3 つで、 いずれかに当たれば allowed:false。
 *   1. その repo_path を掴んでいる active session がある      → session_active
 *   2. その repo のサービスに testing claim が出ている          → testing_claim_active
 *   3. 対象 branch を作業中として登録している session がある     → branch_in_use
 * reason は上の優先順で 1 つ返し、 holders には当たった全員を載せる。
 */
export function evaluateCheckoutLock(input: CheckoutLockInput): CheckoutLockResult {
  const { query, sessions, claims, workspaceRoots } = input;
  const activeSessions = sessions.filter((s) => s.status === "active");
  const targetKey = normalizeRepoKey(query.repo_path);
  const originKey = normalizeRepoOrigin(query.repo_origin).toLowerCase();

  const repoSessions = activeSessions.filter((s) => holdsRepo(s, targetKey, workspaceRoots));
  // repoSessions は既に上で拾っているので、 branch 判定は残りだけを見る
  // (同じ session を 2 度 holders に載せない)。
  const branchSessions = activeSessions.filter(
    (s) => !repoSessions.includes(s) &&
      matchesBranch(s.branch, query.branch) &&
      belongsToRepoLoosely(s, targetKey, originKey),
  );
  const sessionById = new Map(activeSessions.map((s) => [s.id, s] as const));
  const repoClaims = claims.filter((claim) =>
    claimTargetsRepo(claim, sessionById.get(claim.session_id) ?? null, query, targetKey, originKey),
  );
  const claimHolders = () =>
    repoClaims.map((claim) => claimHolder(claim, sessionById.get(claim.session_id) ?? null));

  if (repoSessions.length > 0) {
    return {
      allowed: false,
      reason: "session_active",
      holders: [...repoSessions.map(sessionHolder), ...claimHolders(), ...branchSessions.map(sessionHolder)],
    };
  }
  if (repoClaims.length > 0) {
    return {
      allowed: false,
      reason: "testing_claim_active",
      holders: [...claimHolders(), ...branchSessions.map(sessionHolder)],
    };
  }
  if (branchSessions.length > 0) {
    return { allowed: false, reason: "branch_in_use", holders: branchSessions.map(sessionHolder) };
  }
  return { allowed: true };
}

/**
 * session が **その登録 checkout そのもの**を掴んでいるか。
 * 判定キーは conflict-scope と同じ (target_project 宣言 > umbrella 除外 > repo_path)。
 * ワークスペースルートに居るだけで個別プロジェクト未宣言のセッションは掴んでいない。
 * 同じ repo の別 worktree はここでは掴み手にしない (足元が動くのは branch が一致する
 * ときだけなので、 branch 判定 (branch_in_use) の側で見る)。
 */
function holdsRepo(
  session: SessionRow,
  targetKey: string,
  workspaceRoots: readonly string[],
): boolean {
  const key = conflictRepoKey(session, workspaceRoots);
  return key !== null && key === targetKey;
}

/** branch 判定用のゆるい所属判定 (worktree の別パスを取りこぼさない)。 */
function belongsToRepoLoosely(session: SessionRow, targetKey: string, originKey: string): boolean {
  if (originKey !== "" && sessionOriginKey(session) === originKey) return true;
  const path = normalizeRepoKey(session.repo_path);
  if (path === targetKey) return true;
  const declared = session.target_project?.trim();
  return !!declared && normalizeRepoKey(declared) === targetKey;
}

function sessionOriginKey(session: SessionRow): string {
  return session.repo_origin ? normalizeRepoOrigin(session.repo_origin).toLowerCase() : "";
}

/**
 * testing claim がその repo のサービスに出ているか。
 * claim は service 名しか持たないので、
 *   a. claim した session がその repo (登録 checkout / 同 origin の worktree) に居る、 または
 *   b. service 名が repo 名 (origin の repo 名 / checkout のディレクトリ名) と一致する
 * のどちらかで紐付ける。 claim した session が既に居なくても b で拾えるようにする
 * (session が落ちても Excubitor 上のサービスはテスト中のままでありうる)。
 */
function claimTargetsRepo(
  claim: TestClaimRow,
  session: SessionRow | null,
  query: CheckoutLockQuery,
  targetKey: string,
  originKey: string,
): boolean {
  if (session && belongsToRepoLoosely(session, targetKey, originKey)) return true;
  const service = claim.service.trim().toLowerCase();
  if (!service) return false;
  // 空の repo 名と突き合わせて誤一致させない (repo_origin / repo_path が末尾要素を
  // 持たない形で渡ってきたとき、 service==="" 以外は下で false になるべき)。
  const names = [repoNameOf(query.repo_origin), repoDirNameOf(query.repo_path)].filter(Boolean);
  return names.includes(service);
}

/** `refs/heads/main` と `main` を同じ branch として扱う。 */
function matchesBranch(sessionBranch: string | null, requested: string): boolean {
  if (!sessionBranch) return false;
  return shortRef(sessionBranch) === shortRef(requested);
}

function shortRef(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, "");
}

function sessionHolder(session: SessionRow): CheckoutLockHolder {
  return {
    kind: "session",
    session_id: session.id,
    task: session.current_task,
    branch: session.branch,
    repo_path: session.repo_path,
    since: session.started_at,
  };
}

function claimHolder(claim: TestClaimRow, session: SessionRow | null): CheckoutLockHolder {
  return {
    kind: "testing_claim",
    session_id: claim.session_id,
    task: session?.current_task ?? null,
    branch: claim.branch ?? session?.branch ?? null,
    repo_path: session?.repo_path ?? null,
    service: claim.service,
    note: claim.note,
    since: claim.started_at,
  };
}
