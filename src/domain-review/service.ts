/**
 * src/domain-review/service.ts — ドメインレビュー投稿ジョブの本体。
 *
 * 設計書 §8.2 C-4 の 3 契機 (plan 生成 / local PR 提出 / `/domain-review` の明示要求)
 * から呼ばれ、 Anatomia を読んで Discord へ 1 通投稿し、 その message id を台帳に残す。
 *
 * **投稿しない場合は必ず理由を返す。** 「何も起きなかった」を無言にすると、
 * 発火経路が死んでいても誰も気づけない (Cc が過去に踏んだのと同じ失敗)。
 * ただし *Discord には* エラーを投げない — 自動契機での未 prepare・未登録・
 * Anatomia 停止は、 チャンネルをエラーで埋めずログにだけ残す。
 *
 * SRP: 手順の組み立てだけ。 取得は anatomia-client、 変換は report、
 * 描画と送信は poster (chat-platform 側の実装)。
 *
 * @implements spec/feature/domain-review-discord.md §2, §4
 */

import type { ProjectCodeRow, ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { DomainReviewAnswerKind, DomainReviewRepo } from "../db/domain-review-repo.js";
import { AnatomiaDomainClient, type AnatomiaRawDomain } from "./anatomia-client.js";
import { captureLayerDiagram, type CaptureLayerDiagramInput, type CapturedDiagram } from "./graph-image.js";
import { renderLayerDiagramHtml } from "./layer-diagram.js";
import { appendPlanReviewAnswer, readLatestPlan, readPlan } from "./plan-file.js";
import { buildDomainReviewReport, type DomainReviewPlanInput } from "./report.js";
import type { DomainReviewReport, DomainReviewTarget, DomainReviewTrigger } from "./types.js";

/** 投稿を見送った理由。 API 応答とログにそのまま出す。 */
export type DomainReviewSkipReason =
  | "project_not_registered"
  | "domain_review_disabled"
  | "anatomia_project_unknown"
  | "anatomia_unreachable"
  | "not_prepared"
  | "no_domain_data"
  | "post_failed";

export type DomainReviewOutcome =
  | { posted: true; postId: number; report: DomainReviewReport; imageAttached: boolean }
  | { posted: false; reason: DomainReviewSkipReason };

export interface DomainReviewRequest {
  trigger: DomainReviewTrigger;
  /** project_codes.code。 `/domain-review <code>` 起点。 */
  code?: string | null;
  /** セッションの repo_origin から引く (local PR 提出起点)。 */
  repoOrigin?: string | null;
  /**
   * plan を読む実チェックアウト。Cc 内部の信頼済み呼び出し専用で、HTTP payload
   * からは受け取らない。外部発火は sessionId から登録 origin と突合して解決する。
   */
  repoPath?: string | null;
  /** 明示の投稿先 (slash command を打ったチャンネル)。 */
  channelId?: string | null;
  /** 契機となったセッション。 投稿先の既定解決に使う。 */
  sessionId?: string | null;
  /** plan 起点で対象 plan が分かっている場合の hash。 未指定なら直近 plan。 */
  planTaskHash?: string | null;
}

/** 投稿の実行口。 実装は chat-platform 側 (Cc core は Discord を知らない)。 */
export interface DomainReviewPostPort {
  post(input: {
    report: DomainReviewReport;
    attachmentPaths: readonly string[];
    channelId: string | null;
    sessionId: string | null;
  }): Promise<{ platform: string; channelId: string; messageId: string } | null>;
}

export interface DomainReviewServiceDeps {
  projectCodes: ProjectCodesRepo;
  posts: DomainReviewRepo;
  poster: DomainReviewPostPort;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** 差し替え可能にしておく (vitest は isolate:false で module mock が効かない)。 */
  anatomia?: AnatomiaDomainClient;
  captureImage?: (input: CaptureLayerDiagramInput) => Promise<CapturedDiagram | null>;
  /** 画像添付を無効化する (既定は有効、 失敗しても投稿は続く)。 */
  imagesEnabled?: () => boolean;
  /** HTTP 発火の session_id を、Cc 台帳にある checkout と origin へ解決する。 */
  resolveSession?: (sessionId: string) => { repoPath: string; repoOrigin: string | null } | null;
  /** plan ファイルを更新できる回答者か。未配線は fail-closed。 */
  isReplyAuthorAllowed?: (platform: string, authorId: string) => boolean;
}

export class DomainReviewService {
  private readonly anatomia: AnatomiaDomainClient;
  /** 同じ投稿への再配送と同時返信を直列化し、台帳・plan の lost update を防ぐ。 */
  private readonly replyQueues = new Map<number, Promise<void>>();

  constructor(private readonly deps: DomainReviewServiceDeps) {
    this.anatomia = deps.anatomia ?? new AnatomiaDomainClient();
  }

  /** 1 契機ぶんのドメインレビュー投稿。 */
  async request(input: DomainReviewRequest): Promise<DomainReviewOutcome> {
    const row = this.resolveProjectCode(input);
    if (!row) return this.skip(input, "project_not_registered");
    if (row.domain_review !== 1) return this.skip(input, "domain_review_disabled");

    const target: DomainReviewTarget = {
      code: row.code,
      project: row.project,
      repoPath: this.resolveTargetRepoPath(input, row),
    };

    // sibling worktree は workspace root の Anatomia project に包含されることがある。
    // project-code registry の本体 checkout を正本として先に引き、worktree は plan I/O
    // にだけ使う。登録 path が古い場合に限り実 checkout へフォールバックする。
    let project = await this.anatomia.resolveProjectId(row.repo_path);
    if (!project.ok) return this.skip(input, project.reason === "unreachable"
      ? "anatomia_unreachable"
      : "anatomia_project_unknown");
    let projectId = project.data;
    if (!projectId && target.repoPath !== row.repo_path) {
      project = await this.anatomia.resolveProjectId(target.repoPath);
      if (!project.ok) return this.skip(input, project.reason === "unreachable"
        ? "anatomia_unreachable"
        : "anatomia_project_unknown");
      projectId = project.data;
    }
    if (!projectId) return this.skip(input, "anatomia_project_unknown");

    const [business, program] = await Promise.all([
      this.anatomia.fetchBusinessDomainView(projectId),
      this.anatomia.fetchProgramDomainView(projectId),
    ]);
    if (!business.ok && business.reason === "unreachable" && !program.ok && program.reason === "unreachable") {
      return this.skip(input, "anatomia_unreachable");
    }

    const notes: string[] = [];
    if (!business.ok && program.ok) {
      // The two prepared views describe different halves of the review. Publishing the
      // surviving half without a warning makes a failed request look like authoritative
      // "zero domains" / "zero violations" data.
      notes.push(
        `Anatomia の business-domain-view を取得できなかったため、コアドメイン・関係の情報は不完全です (${business.reason})。`,
      );
    } else if (business.ok && !program.ok) {
      notes.push(
        `Anatomia の program-domain-view を取得できなかったため、層・層違反の情報は不完全です (${program.reason})。`,
      );
    }
    let rawDomains: AnatomiaRawDomain[] | null = null;
    if (!business.ok && !program.ok) {
      // prepared が両方無い = web-cache 未 prepare。 自動契機では投稿しない
      // (人が頼んでいないところへ中身の薄い投稿を流さない)。 明示要求のときだけ
      // 生データで代替し、 prepare を促す但し書きを添える。
      if (input.trigger !== "manual") return this.skip(input, "not_prepared");
      const raw = await this.anatomia.fetchRawDomains(projectId);
      if (!raw.ok) return this.skip(input, raw.reason === "unreachable" ? "anatomia_unreachable" : "not_prepared");
      rawDomains = raw.data;
      notes.push(
        "Anatomia の web-cache が未 prepare のため、層・関係・説明は出せません"
        + " (`POST /api/projects/<id>/prepare-web-cache` の後に再実行してください)。",
      );
    }

    const plan = await this.readPlanFor(input, target);
    const report = buildDomainReviewReport({
      target,
      trigger: input.trigger,
      anatomiaProjectId: projectId,
      businessView: business.ok ? business.data : null,
      programView: program.ok ? program.data : null,
      rawDomains,
      plan,
      notes,
    });
    if (!report) return this.skip(input, "no_domain_data");

    const captured = await this.captureDiagram(report);
    try {
      const posted = await this.deps.poster.post({
        report,
        attachmentPaths: captured ? [captured.pngPath] : [],
        channelId: input.channelId ?? null,
        sessionId: input.sessionId ?? null,
      });
      if (!posted) return this.skip(input, "post_failed");
      const record = this.deps.posts.recordPost({
        code: target.code,
        repoPath: target.repoPath,
        anatomiaProjectId: projectId,
        planTaskHash: report.planTaskHash,
        triggerKind: input.trigger,
        platform: posted.platform,
        channelId: posted.channelId,
        messageId: posted.messageId,
        questions: report.planQuestions,
      });
      this.deps.log.info(
        `domain-review: posted code=${target.code} trigger=${input.trigger} source=${report.source} `
        + `channel=${posted.channelId} message=${posted.messageId} image=${captured ? "yes" : "no"}`,
      );
      return { posted: true, postId: record.id, report, imageAttached: captured !== null };
    } finally {
      await captured?.release();
    }
  }

  /**
   * ドメインレビュー投稿への返信を回答として取り込む (§8.2 C-6)。
   *
   * plan 起点の投稿への返信は `.anatomia/plan/<hash>.json` の `reviewAnswers[]` へ
   * 追記する。 それ以外 (ドメイン説明の修正・紐付け指示) は Cc の台帳に残すだけ —
   * Anatomia 側に自由文を受ける authoring 口が無く、 Gate A は「審査済み提案一式 +
   * expectedHead」しか受け付けないため、 偽の配線を作らない。
   */
  async recordReply(input: {
    platform: string;
    messageId: string;
    authorId: string;
    text: string;
    source: string;
  }): Promise<
    | { handled: false }
    | { handled: true; authorized: false; code: string }
    | { handled: true; authorized: true; kind: DomainReviewAnswerKind; planAppended: boolean; code: string }
  > {
    const post = this.deps.posts.findPostByMessage(input.platform, input.messageId);
    if (!post) return { handled: false };
    const text = input.text.trim();
    if (!text) return { handled: false };
    if (this.deps.isReplyAuthorAllowed?.(input.platform, input.authorId) !== true) {
      this.deps.log.warn(
        `domain-review: reply rejected unauthorized platform=${input.platform} code=${post.code}`,
      );
      return { handled: true, authorized: false, code: post.code };
    }

    return this.enqueueReply(post.id, async () => {
      const existing = this.deps.posts.findAnswerBySource(post.id, input.source);
      if (existing) {
        const kind: DomainReviewAnswerKind = existing.kind === "plan-question"
          ? "plan-question"
          : "domain-note";
        const planAppended = post.plan_task_hash && existing.plan_appended !== 1
          ? await this.appendStoredPlanAnswer(post, {
            id: existing.id,
            answeredBy: existing.answered_by,
            text: existing.answer_text,
            answeredAt: new Date(existing.created_at).toISOString(),
            source: existing.source,
          })
          : existing.plan_appended === 1;
        return {
          handled: true,
          authorized: true,
          kind,
          planAppended,
          code: post.code,
        };
      }

      const kind: DomainReviewAnswerKind = post.plan_task_hash ? "plan-question" : "domain-note";
      const answeredBy = `${input.platform}:${input.authorId}`;
      const answeredAt = new Date().toISOString();
      // 台帳を先に確定する。plan 書込みとの間で停止しても、同じ source の再配送が
      // 未完了の追記を安全に再試行でき、人間の回答そのものは失われない。
      const answer = this.deps.posts.recordAnswer({
        postId: post.id,
        kind,
        answeredBy,
        answerText: text,
        source: input.source,
        planAppended: false,
      });
      const planAppended = post.plan_task_hash
        ? await this.appendStoredPlanAnswer(post, {
          id: answer.id,
          answeredBy: answer.answered_by,
          text: answer.answer_text,
          answeredAt: new Date(answer.created_at).toISOString(),
          source: answer.source,
        })
        : false;
      const storedKind: DomainReviewAnswerKind = answer.kind === "plan-question"
        ? "plan-question"
        : "domain-note";
      return { handled: true, authorized: true, kind: storedKind, planAppended, code: post.code };
    });
  }

  private async appendStoredPlanAnswer(
    post: { id: number; code: string; repo_path: string; plan_task_hash: string | null },
    answer: { id: number; answeredBy: string; text: string; answeredAt: string; source: string },
  ): Promise<boolean> {
    if (!post.plan_task_hash) return false;
    const appended = await appendPlanReviewAnswer(post.repo_path, post.plan_task_hash, {
      answeredBy: answer.answeredBy,
      text: answer.text,
      answeredAt: answer.answeredAt,
      source: answer.source,
    });
    if (appended) {
      this.deps.posts.markAnswerPlanAppended(answer.id);
    } else {
      this.deps.log.warn(
        `domain-review: plan への追記に失敗 code=${post.code} hash=${post.plan_task_hash}`
        + " (回答は Cc の台帳に残っています)",
      );
    }
    return appended;
  }

  private async enqueueReply<T>(postId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.replyQueues.get(postId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.replyQueues.set(postId, tail);
    try {
      return await result;
    } finally {
      if (this.replyQueues.get(postId) === tail) this.replyQueues.delete(postId);
    }
  }

  private resolveProjectCode(input: DomainReviewRequest): ProjectCodeRow | null {
    const code = input.code?.trim();
    if (code) return this.deps.projectCodes.findByCode(code);
    const origin = input.repoOrigin?.trim();
    if (origin) return this.deps.projectCodes.findByRepoOrigin(origin);
    return null;
  }

  private resolveTargetRepoPath(input: DomainReviewRequest, row: ProjectCodeRow): string {
    const trustedPath = input.repoPath?.trim();
    if (trustedPath) return trustedPath;
    const sessionId = input.sessionId?.trim();
    const session = sessionId ? this.deps.resolveSession?.(sessionId) : null;
    if (!session?.repoOrigin) return row.repo_path;
    const sessionProject = this.deps.projectCodes.findByRepoOrigin(session.repoOrigin);
    const sessionPath = session.repoPath.trim();
    return sessionProject?.code === row.code && sessionPath ? sessionPath : row.repo_path;
  }

  /** plan 起点だけ plan を載せる。 PR 提出や明示要求は plan 抜きのドメイン一覧。 */
  private async readPlanFor(
    input: DomainReviewRequest,
    target: DomainReviewTarget,
  ): Promise<DomainReviewPlanInput | null> {
    if (input.trigger !== "plan") return null;
    const hash = input.planTaskHash?.trim();
    return hash ? readPlan(target.repoPath, hash) : readLatestPlan(target.repoPath);
  }

  private async captureDiagram(report: DomainReviewReport): Promise<CapturedDiagram | null> {
    if (this.deps.imagesEnabled?.() === false) return null;
    const capture = this.deps.captureImage ?? captureLayerDiagram;
    try {
      return await capture({
        html: renderLayerDiagramHtml(report),
        slug: report.target.code,
        log: this.deps.log,
      });
    } catch (error) {
      // 画像は任意。 撮影側の想定外例外でも投稿は続ける。
      this.deps.log.warn(`domain-review: 画像化が例外で終わった: ${(error as Error).message}`);
      return null;
    }
  }

  private skip(input: DomainReviewRequest, reason: DomainReviewSkipReason): DomainReviewOutcome {
    this.deps.log.info(
      `domain-review: skip reason=${reason} trigger=${input.trigger} `
      + `code=${input.code ?? "-"} has_origin=${input.repoOrigin ? "yes" : "no"}`,
    );
    return { posted: false, reason };
  }
}
