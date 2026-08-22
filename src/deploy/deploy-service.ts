/**
 * checkout が前進したリポを build して Excubitor 経由で再起動する。
 *
 * 起動・再起動のルールは既存の運用 (`spec/feature/testing-traffic.md` / cc-deploy) と
 * 同じで、この機構はそれを変更しない:
 *
 * - 再起動は **Excubitor 経由**のみ (`npm run dev` 等の直接起動はしない)。
 * - 対象は **プロジェクト本体フォルダ**のみ。 worktree からは build も起動もしない。
 * - 実行中は **testing claim** を出し、終わったら release する。
 *
 * 3 つの段階 (checkout 前進 / build / 再起動) は独立に見えなければならない。 build や
 * 再起動が失敗しても、この関数は**何も巻き戻さない** — 失敗を結果として返すだけにする。
 *
 * @implements spec/feature/checkout-published-deploy.md §3 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RUN`)
 */

import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import type { ControlResult } from "../excubitor/client.js";
import { buildClone, type BuildResult } from "../release/build.js";
import {
  resolveClonePaths,
  repoNameFromOrigin,
  isSafeRepoName,
  isSafeRepoOrigin,
} from "../release/clone-paths.js";
import { openTestingClaim, releaseTestingClaims } from "../testing/claim-lifecycle.js";
import type { DeployOutcome } from "./outcome.js";

/** claim の名義。 人間セッションではないので、由来が分かる固定 id を使う。 */
export const DEPLOY_CLAIM_SESSION_ID = "concordia:checkout-deploy";

/**
 * サービスコード単位の実行チェーン。 同じサービスへの deploy を直列化する。
 *
 * watch 側の重複抑止は repo+sha 単位なので、 **別々の sha が続けて降りてくると**
 * (連続マージ) 2 本の deploy が並走しうる。 その 2 本は claim を同じ
 * `DEPLOY_CLAIM_SESSION_ID` で取るため互いを conflict として検出できず、
 * 先に終わった方の release が後続の claim を消し、 さらに `npm ci` / `npm run build` が
 * 同じディレクトリで衝突する。 claim では守れない範囲なのでプロセス内で直列化する。
 */
const running = new Map<string, Promise<unknown>>();

export interface CheckoutDeployDeps {
  /** リポ名 → Excubitor のサービスコード。 起動を伴わないリポは null。 */
  resolveServiceCode: (repoName: string) => Promise<string | null>;
  /** 本体クローンを探すワークスペースルート。 */
  resolveWorkspaceRoots: () => string[];
  excubitor: { control(code: string, action: "restart"): Promise<ControlResult> };
  claims: TestingClaimsRepo;
  /** テスト差し替え用。 */
  build?: (repoPath: string) => Promise<BuildResult>;
  now?: () => number;
}

export interface CheckoutDeployInput {
  /** `owner/repo` でも `repo` でもよい。 */
  repository: string | null;
  /** 前進先 commit (claim の note 用、無くてもよい)。 */
  sha?: string | null;
}

/**
 * deploy を 1 回試みる。 実行しなかった場合も含め、必ず理由の分かる結果を返す。
 * 例外は投げない — 呼び出し側 (通知購読) は checkout 前進の後始末なので、
 * ここで throw すると「前進したのに何も記録されない」状態になる。
 *
 * @implements spec/feature/checkout-published-deploy.md §3 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RUN`) — deploy の実行
 */
export async function deployAfterCheckoutPublish(
  deps: CheckoutDeployDeps,
  input: CheckoutDeployInput,
): Promise<DeployOutcome> {
  if (!input.repository) {
    return { kind: "skipped", reason: "no_repository", repository: null, serviceCode: null };
  }
  // リポ指定は通知本文の正規表現から来る (= 外部由来) 一方、この後 `join(root, repoName)` の
  // パス片になる。 `..` 等を素通しすると workspace 外を本体クローンとみなして build /
  // 再起動を走らせるため、パス片として安全な名前でなければ deploy しない。
  // 末尾だけを見ると `C:/Windows` のように「危険な前半 + 安全な末尾」を通してしまうので、
  // 分割前に全区間を検査する。
  if (!isSafeRepoOrigin(input.repository)) {
    return { kind: "skipped", reason: "no_repository", repository: null, serviceCode: null };
  }
  const repoName = repoNameFromOrigin(input.repository);
  if (!isSafeRepoName(repoName)) {
    return { kind: "skipped", reason: "no_repository", repository: null, serviceCode: null };
  }
  const serviceCode = await deps.resolveServiceCode(repoName).catch(() => null);
  if (!serviceCode) {
    return { kind: "skipped", reason: "no_service", repository: repoName, serviceCode: null };
  }

  const mainClone = resolveClonePaths(repoName, deps.resolveWorkspaceRoots()).main;
  if (!mainClone) {
    return { kind: "skipped", reason: "no_main_clone", repository: repoName, serviceCode };
  }

  // 同一サービスへの deploy は 1 本ずつ。 先行がいれば、その完了を待ってから claim を取る
  // (失敗も待ち合わせの対象なので握り潰す)。
  const previous = running.get(serviceCode);
  const current = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => runDeploy(deps, { repoName, serviceCode, mainClone, sha: input.sha ?? null }));
  running.set(serviceCode, current);
  try {
    return await current;
  } finally {
    // 自分が最後尾のときだけ掃除する (後続が並んでいればその Promise を残す)。
    if (running.get(serviceCode) === current) running.delete(serviceCode);
  }
}

/**
 * claim → build → restart。 呼び出し元でサービス単位に直列化済みであることを前提とする。
 *
 * @implements spec/feature/checkout-published-deploy.md §3 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RUN`)
 */
async function runDeploy(
  deps: CheckoutDeployDeps,
  target: { repoName: string; serviceCode: string; mainClone: string; sha: string | null },
): Promise<DeployOutcome> {
  const { repoName, serviceCode, mainClone } = target;
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  // claim は advisory だが、再起動は他セッションの起動テストを巻き込む。 衝突している
  // 間は自動 deploy を見送り、人間の deploy 手順 (cc-deploy) に委ねる。
  const claimed = openTestingClaim(deps.claims, {
    service: serviceCode,
    sessionId: DEPLOY_CLAIM_SESSION_ID,
    note: claimNote(repoName, target.sha),
    now,
  });
  if (claimed.conflicts.length > 0) {
    releaseTestingClaims(deps.claims, { sessionId: DEPLOY_CLAIM_SESSION_ID, service: serviceCode, now });
    return { kind: "skipped", reason: "claim_conflict", repository: repoName, serviceCode };
  }

  try {
    const build = await (deps.build ?? buildClone)(mainClone);
    if (!build.ok) {
      return { kind: "failed", stage: "build", repository: repoName, serviceCode, detail: build.error ?? "build failed" };
    }
    const control = await deps.excubitor.control(serviceCode, "restart").catch((e: unknown) => ({
      ok: false,
      action: "restart" as const,
      exit_code: null,
      stderr: (e as Error).message,
    }));
    if (!control.ok) {
      const detail = (control.stderr ?? "").trim() || `exit_code=${control.exit_code ?? "unknown"}`;
      return { kind: "failed", stage: "restart", repository: repoName, serviceCode, detail: detail.slice(-500) };
    }
    return { kind: "deployed", repository: repoName, serviceCode, built: build.ran };
  } finally {
    releaseTestingClaims(deps.claims, {
      sessionId: DEPLOY_CLAIM_SESSION_ID,
      service: serviceCode,
      now: Math.floor((deps.now ?? Date.now)() / 1000),
    });
  }
}

/** claim の note。 何をしている再起動かが一覧から読めるようにする。
 * @implements spec/feature/checkout-published-deploy.md §3 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RUN`) */
function claimNote(repoName: string, sha: string | null): string {
  const at = sha ? ` (${sha.slice(0, 12)})` : "";
  return `checkout 前進の自動 deploy: ${repoName}${at} build → restart`;
}
