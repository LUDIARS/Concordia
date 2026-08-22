/**
 * checkout 前進後の deploy 1 回ぶんの結果と、その 1 行表現。
 *
 * 「main は進んだがサービスは古いまま」を無言にしないことがこの機構の要点なので、
 * **実行した / しなかったのどちらでも理由付きの 1 行を作れる**ようにする。
 * また checkout 前進・build・再起動は別々の段階として見えなければならない
 * (build が失敗しても前進は成立している) ため、段階を型に持たせる。
 *
 * @implements spec/feature/checkout-published-deploy.md §4 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RECORD`)
 */

/** deploy を実行しなかった理由。 */
export type DeploySkipReason =
  /** 通知からリポジトリを特定できなかった。 */
  | "no_repository"
  /** そのリポに Excubitor 登録のサービスが無い (ライブラリ等)。 異常ではない。 */
  | "no_service"
  /** 本体クローンが見つからない (worktree からは起動しないため代替はしない)。 */
  | "no_main_clone"
  /** 別セッションが同じサービスを testing claim 中。 */
  | "claim_conflict";

/** deploy が失敗した段階。 checkout 前進とマージは巻き戻さない。 */
export type DeployFailureStage = "build" | "restart";

export type DeployOutcome =
  | { kind: "skipped"; reason: DeploySkipReason; repository: string | null; serviceCode: string | null }
  | {
      kind: "deployed";
      repository: string;
      serviceCode: string;
      /** build を実際に走らせたか (build script が無いリポは false)。 */
      built: boolean;
    }
  | {
      kind: "failed";
      stage: DeployFailureStage;
      repository: string;
      serviceCode: string;
      detail: string;
    };

const SKIP_TEXT: Record<DeploySkipReason, string> = {
  no_repository: "通知から対象リポジトリを特定できなかった",
  no_service: "Excubitor 登録のサービスが無い",
  no_main_clone: "本体クローンが見つからない (worktree からは起動しない)",
  claim_conflict: "別セッションが同じサービスをテスト中 (testing claim)",
};

const STAGE_TEXT: Record<DeployFailureStage, string> = {
  build: "build",
  restart: "Excubitor 経由の再起動",
};

/**
 * 結果 1 件を 1 行にする。 checkout 前進自体は成功しているので、失敗時も
 * 「前進は済んでいる / deploy だけが失敗した」と読める文にする。
 *
 * @implements spec/feature/checkout-published-deploy.md §4 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RECORD`) — 記録
 */
export function describeDeployOutcome(outcome: DeployOutcome): string {
  const target = outcome.repository ?? "対象不明";
  if (outcome.kind === "skipped") {
    return `checkout 前進 (${target}): deploy を実行しませんでした — ${SKIP_TEXT[outcome.reason]}`;
  }
  if (outcome.kind === "deployed") {
    const build = outcome.built ? "build → " : "build 不要 → ";
    return `checkout 前進 (${target}): ${build}${outcome.serviceCode} を Excubitor 経由で再起動しました`;
  }
  return [
    `checkout 前進 (${target}): ${STAGE_TEXT[outcome.stage]}に失敗しました (${outcome.serviceCode})。`,
    "マージと checkout 前進は成立したままです。",
    `理由: ${outcome.detail}`,
  ].join(" ");
}
