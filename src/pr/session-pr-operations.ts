/**
 * セッション単位の PR 操作 (Revisor local PR の提出とマージ) の実体。
 *
 * RWF (📮 / 🔀) と Discord の操作パネルは、 どちらもこのクラスを通す。 提出は
 * `POST /v1/prs/local` と同じ submitter を受け取って呼ぶだけで、 提出判定を複製しない。
 * マージは PR #297 が切り出した指示者ベースの認可 (`mergeLocalPrForRequester`) を使う。
 *
 * platform (discord / slack) は生成時に束縛する。 リアクションを付けた人の役職は、
 * その platform の名簿で引かなければ意味が無いため。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W2
 */

import type { StaffPlatform } from "../db/staff-repo.js";
import { STAFF_ROLE_LABEL } from "../staff/roles.js";
import type {
  RwfPrActor,
  RwfPrMergeOutcome,
  RwfPrOperations,
  RwfPrSubmitOutcome,
} from "../platform/reaction-workflow-pr.js";
import {
  findOpenLocalPrForBranch,
  listOpenLocalPrsForRepository,
  type SessionLocalPrSubmitter,
} from "./local-pr-submission.js";
import {
  mergeLocalPrForRequester,
  type LocalPrMergeDeps,
} from "./local-pr-merge.js";
import type { RevisorLocalPrSummary } from "./revisor-local-pr-client.js";

/** マージ対象の同定に必要なセッション情報だけ (SessionsRepo の部分)。 */
export interface SessionPrLookup {
  findSession(sessionId: string): { id: string; repo_origin: string | null; branch: string | null } | null;
}

export interface SessionPrOperationsDeps {
  /** 実行者の役職を引く名簿の platform。 */
  platform: StaffPlatform;
  sessions: SessionPrLookup;
  /** `POST /v1/prs/local` と同じ提出関数。 */
  submit: SessionLocalPrSubmitter;
  /** Revisor の local PR 一覧 (マージ対象の特定に使う)。 */
  listLocalPullRequests: () => Promise<RevisorLocalPrSummary[]>;
  /** 認可付きマージの依存 (名簿 / Revisor / 監査シンク)。 */
  merge: LocalPrMergeDeps;
  /** この操作の出所 (監査記録に残る)。 */
  source: string;
}

/**
 * 操作パネル (Discord) が使う口。 RWF の契約に「対象を明示して選ぶ」操作を足したもの。
 * パネルは対象一覧を出して選ばせられるが、 リアクションは対象を選べないため RWF 側は
 * セッションのブランチ PR だけを見る。
 */
export interface SessionPrPort extends RwfPrOperations {
  /** そのセッションのリポジトリで open な local PR (選択肢用)。 */
  listOpenLocalPrs(sessionId: string): Promise<RevisorLocalPrSummary[]>;
  /** 一覧から選ばれた local PR を指示者の権限でマージする。 */
  mergeSelectedLocalPr(input: {
    sessionId: string;
    localPrId: string;
    actor: RwfPrActor;
  }): Promise<RwfPrMergeOutcome>;
}

export class SessionPrOperations implements SessionPrPort {
  constructor(private readonly deps: SessionPrOperationsDeps) {}

  /** 対象セッションの作業ブランチを Revisor local PR として提出する。 */
  async submitLocalPr(input: { sessionId: string; actor: RwfPrActor }): Promise<RwfPrSubmitOutcome> {
    const result = await this.deps.submit(input.sessionId);
    if (result.submitted) {
      return { ok: true, kind: "submitted", pullRequest: toPrRef(result.pullRequest) };
    }
    if ("resubmitted" in result) {
      return { ok: true, kind: "resubmitted", pullRequest: toPrRef(result.pullRequest) };
    }
    return { ok: false, kind: "skipped", reason: result.reason, detail: result.detail };
  }

  /**
   * セッションが提出した open な local PR を、 指示者の権限で確認した上でマージする。
   * 対象が無い場合は `no_local_pr` を返す — 呼び出し側が GitHub 経路へ落とす判断に使う。
   */
  async mergeLocalPr(input: { sessionId: string; actor: RwfPrActor }): Promise<RwfPrMergeOutcome> {
    const session = this.deps.sessions.findSession(input.sessionId);
    if (!session) {
      return { ok: false, kind: "unavailable", detail: "対象セッションが Concordia に見つかりません" };
    }
    if (!session.branch) {
      return { ok: false, kind: "no_local_pr", detail: "セッションに作業ブランチが記録されていません" };
    }

    const pullRequests = await this.deps.listLocalPullRequests();
    const target = findOpenLocalPrForBranch(session.repo_origin, session.branch, pullRequests);
    if (!target) {
      return {
        ok: false,
        kind: "no_local_pr",
        detail: `このセッションのブランチ \`${session.branch}\` に対応する open な Revisor local PR がありません`,
      };
    }

    return this.authorizeAndMerge(session.id, target, input.actor);
  }

  async listOpenLocalPrs(sessionId: string): Promise<RevisorLocalPrSummary[]> {
    const session = this.deps.sessions.findSession(sessionId);
    if (!session) return [];
    return listOpenLocalPrsForRepository(session.repo_origin, await this.deps.listLocalPullRequests());
  }

  async mergeSelectedLocalPr(input: {
    sessionId: string;
    localPrId: string;
    actor: RwfPrActor;
  }): Promise<RwfPrMergeOutcome> {
    const session = this.deps.sessions.findSession(input.sessionId);
    if (!session) {
      return { ok: false, kind: "unavailable", detail: "対象セッションが Concordia に見つかりません" };
    }
    // 選択された ID をそのまま Revisor へ流さず、 そのセッションのリポジトリの open PR に
    // 限る (古いパネルや他リポの ID でマージできてしまわないようにする)。
    const candidates = listOpenLocalPrsForRepository(
      session.repo_origin,
      await this.deps.listLocalPullRequests(),
    );
    const target = candidates.find((pr) => pr.id === input.localPrId);
    if (!target) {
      return {
        ok: false,
        kind: "no_local_pr",
        detail: "選択された local PR はこのセッションのリポジトリで open ではありません",
      };
    }
    return this.authorizeAndMerge(session.id, target, input.actor);
  }

  /** 認可 → マージ → 監査 (共通ヘルパー) を呼び、 結果を操作面の語彙へ写す。 */
  private async authorizeAndMerge(
    sessionId: string,
    target: RevisorLocalPrSummary,
    actor: RwfPrActor,
  ): Promise<RwfPrMergeOutcome> {
    const result = await mergeLocalPrForRequester(this.deps.merge, {
      localPrId: target.id,
      sessionId,
      requester: { platform: this.deps.platform, userId: actor.userId },
      source: this.deps.source,
    });
    if (result.merged) {
      return {
        ok: true,
        kind: "merged",
        pullRequest: toPrRef(target),
        authorizerRole: result.role ? STAFF_ROLE_LABEL[result.role] : null,
      };
    }
    if (result.reason === "not_authorized") {
      return { ok: false, kind: "not_authorized", detail: result.detail };
    }
    return { ok: false, kind: "failed", detail: result.detail };
  }
}

function toPrRef(pr: RevisorLocalPrSummary): { id: string; number: number; repository: string; headRef: string } {
  return { id: pr.id, number: pr.number, repository: pr.repository, headRef: pr.headRef };
}
