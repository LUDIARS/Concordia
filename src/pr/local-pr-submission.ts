/**
 * セッションの作業ブランチを Revisor の local PR として提出する判断とその実行。
 *
 * 背景: レビュー発火は元々「GitHub PR が CI success になったら Revisor の
 * `/v1/pr-gate/jobs` を叩く」経路だったが、 Revisor が local PR ワークフローへ移行して
 * そのエンドポイントは撤去され、 push-guard が feature ブランチの push 自体を禁止した。
 * 結果、 **自動でレビューが走る経路が 1 つも無くなり**、 人が手で local PR を提出した
 * ときだけレビューされる状態になっていた。 ここがその置き換え。
 *
 * 判定は純関数 (`planLocalPrSubmission`) に閉じ、 git と HTTP は呼び出し側が渡す。
 *
 * spec/feature/revisor-local-pr-submission.md §3-§5。
 */

import { normalizeRepoOrigin } from "./normalize.js";
import type { RevisorLocalPrGateway, RevisorLocalPrSummary, RevisorRepositoryRegistration } from "./revisor-local-pr-client.js";
import type { PrSourceLink } from "./session-source-links.js";

/** 提出しない理由。 ログと API 応答でそのまま使う (無言でスキップしない)。 */
export type SkipReason =
  | "no_branch"
  | "on_base_branch"
  | "repository_not_registered"
  | "no_commits"
  | "already_open";

export interface LocalPrPlanInput {
  /**
   * セッションの repo_origin。 `git config --get remote.origin.url` の生値 (URL / SSH)
   * で来るので、 owner/repo へ正規化してから登録と突き合わせる。
   */
  repository: string | null;
  /** セッションが作業していたブランチ。 */
  branch: string | null;
  /** Revisor に登録済みのリポジトリ一覧。 */
  registrations: readonly RevisorRepositoryRegistration[];
  /** Revisor に既にある local PR 一覧。 */
  openPullRequests: readonly RevisorLocalPrSummary[];
  /** base から進んだコミットがあるか。 */
  hasCommits: boolean;
}

export type LocalPrPlan =
  | { submit: false; reason: SkipReason }
  | { submit: false; retry: true; pullRequestId: string }
  | { submit: true; repository: string; headRef: string; baseRef: string };

/**
 * セッションの repo_origin と Revisor の登録リポジトリを突き合わせる。
 *
 * `sessions.repo_origin` は hook が `git config --get remote.origin.url` をそのまま
 * 入れるので `https://github.com/LUDIARS/Concordia.git` や `git@github.com:...` の形で
 * 来る。 一方 Revisor の登録は `owner/repo`。 生値のまま比較すると**どのセッションも
 * 未登録扱いになり、 レビューが 1 件も発火しない** — 無言で発火経路が死ぬという、
 * この機能が潰しに来た障害そのものになる。 双方 owner/repo に寄せてから比較する。
 */
export function findRegistration(
  repository: string | null,
  registrations: readonly RevisorRepositoryRegistration[],
): RevisorRepositoryRegistration | undefined {
  const key = repository ? normalizeRepoOrigin(repository).toLowerCase() : "";
  if (!key) return undefined;
  return registrations.find((row) => normalizeRepoOrigin(row.repository).toLowerCase() === key);
}

/**
 * 提出すべきかを決める。 スキップは必ず理由付きで返す — 「何も起きなかった」を
 * 無言にすると、 発火経路が死んでいても誰も気づけない (それが今回の元の障害)。
 */
export function planLocalPrSubmission(input: LocalPrPlanInput): LocalPrPlan {
  const branch = input.branch?.trim() ?? "";
  if (!branch) return { submit: false, reason: "no_branch" };

  const registration = findRegistration(input.repository, input.registrations);
  if (!registration) return { submit: false, reason: "repository_not_registered" };

  if (branch.toLowerCase() === registration.baseRef.toLowerCase()) {
    return { submit: false, reason: "on_base_branch" };
  }
  if (!input.hasCommits) return { submit: false, reason: "no_commits" };

  // 同じブランチの open な local PR が既にあるなら二重提出しない (再実行しても安全)。
  // ブランチ名だけは git と同じく大文字小文字を区別する (別ブランチなので)。
  const registeredKey = normalizeRepoOrigin(registration.repository).toLowerCase();
  const duplicate = input.openPullRequests.find((pr) =>
    pr.status === "open"
    && normalizeRepoOrigin(pr.repository).toLowerCase() === registeredKey
    && pr.headRef === branch);
  if (duplicate) {
    if (duplicate.checkStatus === "failed" || duplicate.checkStatus === "action_required") {
      return { submit: false, retry: true, pullRequestId: duplicate.id };
    }
    return { submit: false, reason: "already_open" };
  }

  return {
    submit: true,
    repository: registration.repository,
    headRef: branch,
    baseRef: registration.baseRef,
  };
}

export interface LocalPrSubmissionDeps {
  revisor: RevisorLocalPrGateway;
  /** base..branch のコミット件名を新しい順で返す (空なら commits 無し)。 */
  listBranchCommits(repoPath: string, baseRef: string, branch: string): Promise<string[]>;
  resolveSourceLinks?: (sessionId: string) => Promise<readonly PrSourceLink[]>;
  log: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
}

export interface LocalPrSubmissionRequest {
  /** 提出元セッション。 direct 提出 (branch 直指定) では null — binding を付けない。 */
  sessionId: string | null;
  repoPath: string;
  repository: string | null;
  branch: string | null;
  /**
   * 提出者が書いた PR 本文。 渡すとコミット件名からの自動生成に代えてそのまま使う。
   *
   * Revisor は本文に `## 実装内容` / `## 受け入れ条件` を要求するが、 自動生成は
   * コミット件名を並べるだけでそれを満たせない。 中身を知っているのは書き手なので、
   * 本文は書き手から受け取れるようにする (省略時は従来どおり自動生成)。
   */
  prContent?: string | null;
}

export type LocalPrSubmissionResult =
  | { submitted: true; pullRequest: RevisorLocalPrSummary }
  | { submitted: false; resubmitted: true; pullRequest: RevisorLocalPrSummary }
  | { submitted: false; reason: SkipReason | "error"; detail?: string };

/** PR 本文の上限。 Revisor 側の受け入れ上限 (65536) に合わせる。 */
const MAX_PR_CONTENT_LENGTH = 65_536;

/**
 * コミット件名から PR タイトルと本文を作る。 先頭 (最新) をタイトルにする。
 *
 * `prContent` が渡されたときは本文の自動生成を行わず、 書き手の文章をそのまま使う。
 * 提出の由来 (session / direct) は本文の意味に関わらないので付け足さない — 付けると
 * 書き手が構成した見出し構造の外に行が混ざる。
 */
function describe(
  commits: readonly string[],
  sessionId: string | null,
  prContent?: string | null,
): { title: string; body: string } {
  const subjects = commits.filter((line) => line.trim().length > 0);
  const title = subjects[0]?.slice(0, 200) ?? "Local branch review";
  const authored = typeof prContent === "string" ? prContent.trim() : "";
  if (authored) {
    return { title, body: authored.slice(0, MAX_PR_CONTENT_LENGTH) };
  }
  const body = [
    sessionId
      ? `Concordia session \`${sessionId}\` の作業ブランチを自動提出しました。`
      : "ブランチ直指定 (direct) で提出しました。審査結果は共有チャット通知で確認してください。",
    "",
    ...(subjects.length > 0 ? ["コミット:", ...subjects.map((s) => `- ${s}`)] : []),
  ].join("\n");
  return { title, body };
}

/**
 * 1 セッション分の提出を試みる。 例外は投げず結果として返す — セッション終了処理を
 * レビュー発火の失敗で壊さないため。
 */
export async function submitSessionLocalPr(
  deps: LocalPrSubmissionDeps,
  request: LocalPrSubmissionRequest,
): Promise<LocalPrSubmissionResult> {
  try {
    const [registrations, openPullRequests] = await Promise.all([
      deps.revisor.listRepositories(),
      deps.revisor.listLocalPullRequests(),
    ]);
    // base ref は登録側が正本なので、 コミット確認の前に登録を解決しておく
    // (照合規則は plan と同じ関数を使う — ここだけ揺れると未登録扱いで黙って止まる)。
    const registration = findRegistration(request.repository, registrations);
    // plan と同じ trim を通してから git に渡す。 生値を渡すと空白付きのブランチ名で
    // git が落ち、 plan なら通る提出が "error" として消える。
    const branch = request.branch?.trim() ?? "";
    const commits = registration && branch
      ? await deps.listBranchCommits(request.repoPath, registration.baseRef, branch)
      : [];

    const plan = planLocalPrSubmission({
      repository: request.repository,
      branch: request.branch,
      registrations,
      openPullRequests,
      hasCommits: commits.length > 0,
    });
    if (!plan.submit && "retry" in plan) {
      const pullRequest = await deps.revisor.retryLocalPullRequest(plan.pullRequestId);
      deps.log.info(
        {
          session_id: request.sessionId,
          repository: request.repository,
          branch: request.branch,
          local_pr_id: pullRequest.id,
          local_pr_number: pullRequest.number,
        },
        "resubmitted local PR for review",
      );
      return { submitted: false, resubmitted: true, pullRequest };
    }
    if (!plan.submit) {
      deps.log.info(
        { session_id: request.sessionId, repository: request.repository, branch: request.branch, reason: plan.reason },
        "local PR submission skipped",
      );
      return { submitted: false, reason: plan.reason };
    }

    const { title, body } = describe(commits, request.sessionId, request.prContent);
    // Source links are supplemental navigation metadata. A transient Discord/Slack
    // lookup failure must not prevent the local PR itself from being submitted.
    let sourceLinks: readonly PrSourceLink[] = [];
    try {
      sourceLinks = request.sessionId
        ? await deps.resolveSourceLinks?.(request.sessionId) ?? []
        : [];
    } catch (error) {
      deps.log.warn(
        { session_id: request.sessionId, err: error instanceof Error ? error.message : String(error) },
        "local PR source-link resolution failed",
      );
    }
    const pullRequest = await deps.revisor.submitLocalPullRequest({
      repository: plan.repository,
      title,
      body,
      author: "concordia",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      headRef: plan.headRef,
      baseRef: plan.baseRef,
      sourceLinks,
    });
    deps.log.info(
      {
        session_id: request.sessionId,
        repository: plan.repository,
        branch: plan.headRef,
        local_pr_id: pullRequest.id,
        local_pr_number: pullRequest.number,
      },
      "submitted local PR for review",
    );
    return { submitted: true, pullRequest };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log.warn(
      { session_id: request.sessionId, repository: request.repository, branch: request.branch, err: detail },
      "local PR submission failed",
    );
    return { submitted: false, reason: "error", detail };
  }
}
