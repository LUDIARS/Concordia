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
 * spec/feature/revisor-local-pr-submission.md §3-§5, §9。
 */

import { findOpenLocalPrForBranch, findRegistration } from "./local-pr-lookup.js";
// 同定規則は local-pr-lookup が正本。 既存の import 元を変えないよう、ここから再輸出する。
export { findOpenLocalPrForBranch, findRegistration, listOpenLocalPrsForRepository } from "./local-pr-lookup.js";
import type { RevisorLocalPrGateway, RevisorLocalPrSummary, RevisorRepositoryRegistration } from "./revisor-local-pr-client.js";
import type { PrSourceLink } from "./session-source-links.js";
import type { SessionTaskPrContent } from "./session-task-pr-content.js";
import { isInconclusiveSubmissionError, reconcileInconclusiveSubmission } from "./submission-reconcile.js";

/** 提出しない理由。 ログと API 応答でそのまま使う (無言でスキップしない)。 */
export type SkipReason =
  | "no_branch"
  | "on_base_branch"
  | "repository_not_registered"
  | "no_commits"
  | "already_open"
  | "team_revisor_lane_github";

export interface LocalPrPlanInput {
  /**
   * セッションの repo_origin。 `git config --get remote.origin.url` の生値 (URL / SSH)
   * で来るので、 owner/repo へ正規化してから登録と突き合わせる。
   */
  repository: string | null;
  /** セッションが作業していたブランチ。 */
  branch: string | null;
  /** fast lane への昇格は、この session が提出した重複 PR に限る。 */
  sessionId?: string | null;
  /** Revisor に登録済みのリポジトリ一覧。 */
  registrations: readonly RevisorRepositoryRegistration[];
  /** Revisor に既にある local PR 一覧。 */
  openPullRequests: readonly RevisorLocalPrSummary[];
  /** base から進んだコミットがあるか。 */
  hasCommits: boolean;
  /** 予約済みの審査枠を使うというセッションからの明示指示。 */
  fastLane?: boolean;
  /**
   * team settings `revisor_lane` (teams §3.1)。 `"github"` のチーム (全リポ private な org 相当) は
   * Revisor local PR 経路を使わない — 通常の GitHub PR 運用に委ねるため、 ここでは
   * 提出せず理由付きでスキップする。 未指定 (チーム未所属) は従来どおり local 提出。
   */
  revisorLane?: "local" | "github";
}

export type LocalPrPlan =
  | { submit: false; reason: SkipReason }
  | { submit: false; retry: true; pullRequestId: string }
  | { submit: false; promote: true; pullRequestId: string }
  | { submit: true; repository: string; headRef: string; baseRef: string };

/**
 * 提出すべきかを決める。 スキップは必ず理由付きで返す — 「何も起きなかった」を
 * 無言にすると、 発火経路が死んでいても誰も気づけない (それが今回の元の障害)。
 */
export function planLocalPrSubmission(input: LocalPrPlanInput): LocalPrPlan {
  const branch = input.branch?.trim() ?? "";
  if (!branch) return { submit: false, reason: "no_branch" };

  if (input.revisorLane === "github") return { submit: false, reason: "team_revisor_lane_github" };

  const registration = findRegistration(input.repository, input.registrations);
  if (!registration) return { submit: false, reason: "repository_not_registered" };

  if (branch.toLowerCase() === registration.baseRef.toLowerCase()) {
    return { submit: false, reason: "on_base_branch" };
  }
  if (!input.hasCommits) return { submit: false, reason: "no_commits" };

  // 同じブランチの open な local PR が既にあるなら二重提出しない (再実行しても安全)。
  // 同定規則は findOpenLocalPrForBranch が正本 (マージ対象の選択と同じ規則を使う)。
  const duplicate = findOpenLocalPrForBranch(registration.repository, branch, input.openPullRequests);
  if (duplicate) {
    if (duplicate.checkStatus === "failed" || duplicate.checkStatus === "action_required") {
      return { submit: false, retry: true, pullRequestId: duplicate.id };
    }
    if (
      input.fastLane === true
      && duplicate.checkStatus === "queued"
      && !!input.sessionId
      && duplicate.sessionId === input.sessionId
    ) {
      return { submit: false, promote: true, pullRequestId: duplicate.id };
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
  /**
   * 作業ブランチにある task md から、Revisor 提出用の日本語 PR 内容を組み立てる。
   *
   * 省略可能にしてあるのは direct 提出の呼び出し側 (session を持たない) のため。
   * 渡されていても、`pr_content` が明示されたときと session が無いときは呼ばない。
   */
  loadSessionTaskPrContent?: (repoPath: string, sessionId: string) => Promise<SessionTaskPrContent>;
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
  /** 明示時だけ fast lane を使う。セッション終了時の自動提出は指定しない。 */
  fastLane?: boolean;
  /** team settings `revisor_lane`。 未指定 (チーム未所属) は従来どおり local 提出。 */
  revisorLane?: "local" | "github";
}

export type LocalPrSubmissionResult =
  | { submitted: true; pullRequest: RevisorLocalPrSummary }
  | { submitted: false; resubmitted: true; pullRequest: RevisorLocalPrSummary }
  | { submitted: false; reason: SkipReason | "error"; detail?: string };

/** RWF と操作パネルが共有する、セッション単位の提出結果。 */
export type SessionLocalPrSubmission =
  | { submitted: true; pullRequest: RevisorLocalPrSummary }
  | { submitted: false; resubmitted: true; pullRequest: RevisorLocalPrSummary }
  | { submitted: false; reason: string; detail?: string };

export type SessionLocalPrSubmitter = (sessionId: string) => Promise<SessionLocalPrSubmission>;

/** PR 本文の上限。 Revisor 側の受け入れ上限 (65536) に合わせる。 */
const MAX_PR_CONTENT_LENGTH = 65_536;
const MAX_PR_TITLE_LENGTH = 200;
const JAPANESE_TEXT_PATTERN = /[぀-ヿ㐀-鿿]/;
const REQUIRED_TASK_SECTIONS = ["## 実装内容", "## 受け入れ条件"] as const;

/**
 * task md 由来の内容が Revisor の契約を満たすか。切り詰め後のタイトルと必須 2 節が
 * それぞれ日本語を含むことまで確認し、満たさない内容はコミット件名からの自動生成へ落とす。
 */
function satisfiesTaskContentContract(content: SessionTaskPrContent): boolean {
  if (!JAPANESE_TEXT_PATTERN.test(content.title.slice(0, MAX_PR_TITLE_LENGTH))) return false;
  return REQUIRED_TASK_SECTIONS.every((heading) => {
    const headingMatch = new RegExp(`^${heading}\\s*$`, "m").exec(content.body);
    if (!headingMatch) return false;
    const rest = content.body.slice(headingMatch.index + headingMatch[0].length);
    const nextHeading = rest.search(/^##\s/m);
    const section = (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).trim();
    // buildSessionTaskPrContent が付ける日本語の H3 タスク名だけで通過させず、
    // 目的・完了条件そのものが日本語で設計されていることを確認する。
    const sectionWithoutHeadings = section.replace(/^#{1,6}\s+.*$/gm, "").trim();
    return sectionWithoutHeadings.length > 0 && JAPANESE_TEXT_PATTERN.test(sectionWithoutHeadings);
  });
}

/**
 * コミット件名から PR タイトルと本文を作る。 先頭 (最新) をタイトルにする。
 *
 * `prContent` が渡されたときは本文の自動生成を行わず、 書き手の文章をそのまま使う。
 * 提出の由来 (session / direct) は本文の意味に関わらないので付け足さない — 付けると
 * 書き手が構成した見出し構造の外に行が混ざる。
 *
 * `prContent` が無いときは、設計の正本である task md (`taskContent`) を次に見る。
 * コミット件名は「何をしたか」しか持たないので、 task md があるならそちらが PR 内容として
 * 正しい。 ただし task md が無い / 受け入れ条件が空のときはコミット件名からの自動生成へ
 * 落とす — 空セクションのまま送ると Revisor の内容契約で 400 になり、 session を持たない
 * direct 提出が一切通らなくなる。
 *
 * 省略時の自動生成も Revisor の PR 内容契約 (`local-contracts.mjs` の `prContent`) を
 * 満たす形にする — `## 実装内容` と `## 受け入れ条件` が両方あり、どちらも非空かつ日本語を
 * 含むこと。本文を渡せるようにしても省略はできるので、フォールバックが契約から外れていると
 * **Cc 経由の提出がそのまま 400 になる** (2026-08-10 に全セッションで発生)。
 *
 * 各節の先頭に日本語の導入行を置くのは体裁ではなく契約の要件。 コミット件名は英語のことが
 * あり、箇条書きだけでは日本語判定を満たせない。
 */
function describe(
  commits: readonly string[],
  sessionId: string | null,
  prContent?: string | null,
  taskContent?: SessionTaskPrContent | null,
): { title: string; body: string } {
  const subjects = commits.map((line) => line.trim()).filter((line) => line.length > 0);
  const subjectTitle = subjects[0] ?? "ローカルブランチの審査";
  // Revisor はタイトルにも日本語を要求する。英語だけの Conventional Commit 件名を
  // そのまま送ると、本文が契約を満たしていても提出全体が 400 になる。
  const truncatedSubject = subjectTitle.slice(0, MAX_PR_TITLE_LENGTH);
  const title = (JAPANESE_TEXT_PATTERN.test(truncatedSubject)
    ? truncatedSubject
    : `変更: ${subjectTitle}`).slice(0, MAX_PR_TITLE_LENGTH);
  const authored = typeof prContent === "string" ? prContent.trim() : "";
  if (authored) {
    return { title, body: authored.slice(0, MAX_PR_CONTENT_LENGTH) };
  }
  if (taskContent && satisfiesTaskContentContract(taskContent)) {
    // 設計 (task md) は本文の主部、 提出の事実 (session / コミット) は末尾の付記。
    // 順序を逆にすると審査側が最初に読むのが設計ではなく提出メタになる。
    const submissionInfo = [
      "",
      "## 提出情報",
      `- Concordia セッション: \`${sessionId}\``,
      ...(subjects.length > 0 ? ["- 実装コミット:", ...subjects.map((subject) => `  - ${subject}`)] : []),
    ].join("\n");
    const body = `${taskContent.body.trimEnd()}\n${submissionInfo}`;
    // 先頭から単純に切ると末尾側の受け入れ条件を失い、Revisor が 400 を返す。
    // 過大な task は契約準拠の自動生成へ落とし、壊れた task 本文を送らない。
    if (body.length <= MAX_PR_CONTENT_LENGTH) {
      return { title: taskContent.title.slice(0, MAX_PR_TITLE_LENGTH), body };
    }
  }
  const body = [
    sessionId
      ? `Concordia session \`${sessionId}\` の作業ブランチを自動提出しました。`
      : "ブランチ直指定 (direct) で提出しました。審査結果は共有チャット通知で確認してください。",
    "",
    "## 実装内容",
    subjects.length > 0
      ? "このブランチに含まれるコミットは以下のとおりです。"
      : "コミット件名を取得できなかったため、変更内容は差分を参照してください。",
    ...subjects.map((subject) => `- ${subject}`),
    "",
    "## 受け入れ条件",
    "- Revisor の審査ゲート (登録テスト・情報漏洩・Anatomia・セキュリティ) を通過すること。",
    "- 上記コミットの範囲を超える変更を含まないこと。",
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
  let submissionAttempted = false;
  try {
    if (request.fastLane === true && !request.sessionId) {
      return { submitted: false, reason: "error", detail: "fast lane requires a Concordia session" };
    }
    // GitHub lane is a route choice, not a Revisor planning outcome. Decide it before any
    // Revisor read so an unavailable local service cannot turn the intended skip into an error.
    if (request.revisorLane === "github") {
      deps.log.info(
        { session_id: request.sessionId, repository: request.repository, branch: request.branch, reason: "team_revisor_lane_github" },
        "local PR submission skipped",
      );
      return { submitted: false, reason: "team_revisor_lane_github" };
    }
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
      sessionId: request.sessionId,
      registrations,
      openPullRequests,
      hasCommits: commits.length > 0,
      fastLane: request.fastLane === true,
      revisorLane: request.revisorLane,
    });
    if (!plan.submit && "retry" in plan) {
      let pullRequest = await deps.revisor.retryLocalPullRequest(plan.pullRequestId);
      if (
        request.fastLane === true
        && request.sessionId
        && pullRequest.sessionId === request.sessionId
      ) {
        pullRequest = await deps.revisor.promoteLocalPullRequest(pullRequest.id, request.sessionId);
      }
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
    if (!plan.submit && "promote" in plan) {
      if (!request.sessionId) {
        return { submitted: false, reason: "error", detail: "fast lane requires a Concordia session" };
      }
      const pullRequest = await deps.revisor.promoteLocalPullRequest(
        plan.pullRequestId,
        request.sessionId,
      );
      deps.log.info({
        session_id: request.sessionId,
        local_pr_id: pullRequest.id,
        local_pr_number: pullRequest.number,
      }, "promoted queued local PR to fast lane");
      return { submitted: false, resubmitted: true, pullRequest };
    }
    if (!plan.submit) {
      deps.log.info(
        { session_id: request.sessionId, repository: request.repository, branch: request.branch, reason: plan.reason },
        "local PR submission skipped",
      );
      return { submitted: false, reason: plan.reason };
    }

    // task md は `pr_content` が無いときだけ読む。 読めなくても提出は止めない
    // (コミット件名の自動生成へ落とす) — 設計の写しは本文の質の問題であって、
    // レビューを発火させない理由にはならない。
    const authoredContent = typeof request.prContent === "string" ? request.prContent.trim() : "";
    const taskContent = !authoredContent && request.sessionId && deps.loadSessionTaskPrContent
      ? await deps.loadSessionTaskPrContent(request.repoPath, request.sessionId).catch((error) => {
        // 例外本文やローカル絶対パスは、資格情報・個人名を含み得るためログへ載せない。
        deps.log.warn({
          session_id: request.sessionId,
          error_type: error instanceof Error ? error.name : typeof error,
        }, "task md からの PR 内容生成に失敗した");
        return null;
      })
      : null;
    const { title, body } = describe(commits, request.sessionId, request.prContent, taskContent);
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
    submissionAttempted = true;
    const pullRequest = await deps.revisor.submitLocalPullRequest({
      repository: plan.repository,
      title,
      body,
      author: "concordia",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      headRef: plan.headRef,
      baseRef: plan.baseRef,
      sourceLinks,
      ...(request.fastLane === true ? { fastLane: true } : {}),
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
    // 結果不明の失敗 (client timeout 等) は「出せなかった」とは限らない。 Revisor 側に
    // PR ができていないかを確認してから返す (submission-reconcile.ts の説明を参照)。
    if (submissionAttempted && isInconclusiveSubmissionError(error)) {
      const reconciled = await reconcileInconclusiveSubmission({
        repository: request.repository,
        branch: request.branch?.trim() ?? "",
        listOpenPullRequests: () => deps.revisor.listLocalPullRequests(),
      });
      if (reconciled) {
        deps.log.info(
          {
            session_id: request.sessionId,
            repository: request.repository,
            branch: request.branch,
            local_pr_id: reconciled.id,
            local_pr_number: reconciled.number,
          },
          "local PR submission response was lost but the PR exists; reporting it as submitted",
        );
        return { submitted: true, pullRequest: reconciled };
      }
    }
    deps.log.warn(
      { session_id: request.sessionId, repository: request.repository, branch: request.branch, err: detail },
      "local PR submission failed",
    );
    return { submitted: false, reason: "error", detail };
  }
}
