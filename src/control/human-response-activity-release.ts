/**
 * 「人間の応答待ちの確認」(human_response_confirmation) を、そのセッション自身の観測された動きで
 * 解く判定。質問カードの回答や出所付き inject を経ずに作業を再開したセッション (例: 親経由で
 * 回答を受けた子) が、管制で人間待ちのまま残らないようにする。
 *
 * 動きとして数えるのは、AI の発言や自動の inject では起きない変化だけ:
 *   - フラグが立った後のコミット (HEAD のコミット時刻が立った時刻より新しい、または HEAD が基準から変わった)
 *   - そのセッションの審査中 PR の提出・head の更新 (`<number>:<headSha>` が基準に無い)
 * 観測できなかった項目 (null) は比べない。
 *
 * @implements spec/feature/human-response-confirmation.md
 */
import type { SessionsRepo } from "../db/sessions-repo.js";

export const CONFIRMATION_KEY = "human_response_confirmation";
export const CONFIRMATION_AT_KEY = "human_response_confirmation_at";
export const CONFIRMATION_BASELINE_KEY = "human_response_confirmation_baseline";
export const CONFIRMATION_RELEASE_KEY = "human_response_confirmation_released";

export interface ConfirmationActivity {
  head: string | null;
  /** HEAD のコミット時刻 (epoch-sec)。 */
  headCommittedAt: number | null;
  /** そのセッションの審査中 PR (`<number>:<headSha>`)。照会できなければ null。 */
  prs: string[] | null;
}

interface Baseline { head: string | null; prs: string[] | null }

export type ConfirmationReleaseDecision =
  | { kind: "keep" }
  | { kind: "baseline"; baseline: Baseline }
  | { kind: "release"; reason: string };

function asBaseline(value: unknown): Baseline | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const head = typeof record.head === "string" ? record.head : null;
  const prs = Array.isArray(record.prs) ? record.prs.filter((pr): pr is string => typeof pr === "string") : null;
  return { head, prs };
}

/** 待ちのフラグが立っている metadata と今回の観測から、解く / 基準を残す / 据え置くを決める。 */
export function decideConfirmationRelease(
  metadata: Record<string, unknown>, observed: ConfirmationActivity,
): ConfirmationReleaseDecision {
  if (metadata[CONFIRMATION_KEY] !== true) return { kind: "keep" };
  const claimedAt = typeof metadata[CONFIRMATION_AT_KEY] === "number" ? metadata[CONFIRMATION_AT_KEY] as number : null;
  if (claimedAt !== null && observed.headCommittedAt !== null && observed.headCommittedAt > claimedAt) {
    return { kind: "release", reason: "確認の後に新しいコミット" };
  }
  const baseline = asBaseline(metadata[CONFIRMATION_BASELINE_KEY]);
  if (!baseline) return { kind: "baseline", baseline: { head: observed.head, prs: observed.prs } };
  if (baseline.head !== null && observed.head !== null && baseline.head !== observed.head) {
    return { kind: "release", reason: "確認の後に HEAD が変化" };
  }
  // 新しい PR の提出・head の更新だけを数える。PR が一覧から消えるのは自動マージなど
  // セッション以外の動きでも起きるので数えない。
  if (baseline.prs !== null && observed.prs !== null && observed.prs.some((pr) => !baseline.prs!.includes(pr))) {
    return { kind: "release", reason: "確認の後に審査中 PR を提出・更新" };
  }
  return { kind: "keep" };
}

/**
 * 判定を metadata に適用する。解いたら true。判定と書き込みは 1 回の updateMetadata の中で行う
 * (その間に人間の回答や新しい確認が入っても上書きしない)。
 */
export function releaseConfirmationOnActivity(
  repo: Pick<SessionsRepo, "updateMetadata">, sessionId: string, observed: ConfirmationActivity, nowSec: number,
): string | null {
  let released: string | null = null;
  repo.updateMetadata(sessionId, (metadata) => {
    const decision = decideConfirmationRelease(metadata, observed);
    if (decision.kind === "baseline") return { ...metadata, [CONFIRMATION_BASELINE_KEY]: decision.baseline };
    if (decision.kind === "keep") return metadata;
    released = decision.reason;
    return {
      ...metadata,
      [CONFIRMATION_KEY]: false,
      [CONFIRMATION_BASELINE_KEY]: null,
      [CONFIRMATION_RELEASE_KEY]: { at: nowSec, by: "observed_activity", reason: decision.reason },
    };
  });
  return released;
}
