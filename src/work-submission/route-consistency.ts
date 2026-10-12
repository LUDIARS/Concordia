// 提出経路とハーネスの main 直 push 許可リストの食い違い検知 (純関数)。
// 2 つは別の設定のまま残し、矛盾する組み合わせだけを警告する (spec/feature/work-submission.md §3.1)。
//
// 矛盾は一方向だけ: 許可リストは「GitHub の main へ直接 push してよい」なので、そのリポの経路が
// direct-main 以外 (PR を作る経路) だと、push は通るのに提出は PR を要求する。
// 逆の「direct-main だが許可リストに無い」は Castra / Villa の正規形 (main へ直接コミットし、
// GitHub への送出は Revisor が行う) なので警告しない。

import type { SubmissionRouteName } from "./submission-route.js";

export function mainPushRouteWarning(input: { route: SubmissionRouteName; mainPushAllowlisted: boolean }): string | null {
  if (!input.mainPushAllowlisted || input.route === "direct-main") return null;
  return `main 直 push の許可リスト (harness.main_push_allowlist) に載っているが、提出経路は ${input.route}。`
    + "直接 push する運用なら CONCORDIA_DIRECT_MAIN_REPOS に、PR で出す運用なら許可リストから外す。";
}
