/**
 * /v1/prs — PR キュー API.
 *
 * @implements spec/feature/revisor-local-pr-submission.md — local PR の提出・認可付き変更操作
 *
 *  GET /v1/prs
 *    各 session が作った PR を「対応すべき順」 に並べたキューを返す.
 *    クエリ (任意): repo (repo_origin filter) / author (session_id filter) /
 *                    include_merged=1 (最近マージも grouped に含める, 既定 true)
 *    レスポンス: { generated_at, counts, grouped:{ready,needs_review,in_progress,merged_recent}, queue }
 *
 *  GET /v1/prs/digest
 *    上記を Markdown 1 枚にした AI/Discord 共用ダイジェスト ({ markdown }).
 *
 *  GET /v1/prs/list?state=&repo=&author=&limit=
 *    生の pr_records 行を filter して返す (デバッグ / 詳細閲覧用).
 *
 *  GET /v1/prs/revisor
 *    Revisor (ローカル PR レビューサービス) の local PR 一覧を代理取得する
 *    ({ configured, base_url, pull_requests, error })。 GitHub PR とは別系統.
 *
 *  GET /v1/prs/revisor/digest?repository=
 *    上記を Markdown 1 枚にした AI/Discord 共用ダイジェスト ({ markdown, open_count, error }).
 *
 * 認証は loopback 想定で無し (他 /v1 と同じ).
 */

import { Hono } from "hono";
import type { PrRecordsRepo, PrState } from "../db/pr-records-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { StaffRepo } from "../db/staff-repo.js";
import { buildPrQueue } from "../pr/queue.js";
import { buildRevisorLocalPrDigest } from "../pr/local-pr-listing.js";
import { isOwnerRepo } from "../pr/normalize.js";
import { renderPrQueueMarkdown } from "../pr/render.js";
import type {
  RevisorLocalPrCloser,
  RevisorLocalPrMerger,
  RevisorLocalPrPromoter,
  RevisorLocalPrReader,
} from "../pr/revisor-client.js";
import { classifyMergeFailure, RevisorMergeError } from "../pr/revisor-merge-outcome.js";
import { findLocalPrById, isAlreadyMerged } from "../pr/revisor-merge-confirm.js";
import { decideSessionMergeScope } from "../pr/session-merge-scope.js";
import { lastHumanRequester } from "../control/requester.js";
import { authorizeStaffCapability } from "../staff/capability-authorization.js";
import { createChildLogger } from "../shared/logger.js";

export interface PrsApiDeps {
  prs: PrRecordsRepo;
  /** Revisor local PR の読み取り口。 未注入なら /v1/prs/revisor は configured=false。 */
  revisor?: RevisorLocalPrReader;
  /**
   * session の作業ブランチを Revisor の local PR として提出する。 未注入なら
   * POST /v1/prs/local は生えない (レビュー発火なしの構成)。
   */
  submitLocalPr?: (sessionId: string, options?: { fastLane?: boolean }) => Promise<
    | { submitted: true; pullRequest: { id: string; number: number; repository: string } }
    | { submitted: false; resubmitted: true; pullRequest: { id: string; number: number; repository: string } }
    | { submitted: false; reason: string; detail?: string }
  >;
  /** session の直近人間指示者を監査付きマージの認可者として解決する。 */
  sessions?: Pick<SessionsRepo, "recentEvents" | "eventsByKind" | "appendEvent" | "findSession">;
  /** platform ごとの staff role を live 参照する。 */
  staff?: Pick<StaffRepo, "roleOf">;
  /** Revisor local PR の変更操作。未注入時は fail-closed。 */
  revisorMerger?: RevisorLocalPrMerger;
  /** Revisor local PR の取り下げ操作。未注入時は fail-closed。 */
  revisorCloser?: RevisorLocalPrCloser;
  /** queued local PR を active session の明示指示で fast lane へ移す。 */
  revisorPromoter?: RevisorLocalPrPromoter;
  /**
   * session 非依存の direct 提出 (repo_path + branch)。 未注入なら
   * POST /v1/prs/local/direct は 503。
   */
  submitDirectLocalPr?: (request: {
    repoPath: string;
    branch?: string;
    sessionId?: string;
    prContent?: string;
    fastLane?: boolean;
  }) => Promise<
    | { submitted: true; pullRequest: { id: string; number: number; repository: string } }
    | { submitted: false; resubmitted: true; pullRequest: { id: string; number: number; repository: string } }
    | { submitted: false; reason: string; detail?: string }
  >;
}

const VALID_STATES: PrState[] = ["draft", "open", "merged", "closed"];
const log = createChildLogger("prs-api");

/** 取り下げ理由は監査ログと Revisor 双方に載るので、素性の知れない長文は切り詰める。 */
const MAX_CLOSE_REASON_LENGTH = 500;
const MAX_REPOSITORY_FILTER_LENGTH = 255;

function isValidRepositoryFilter(repository: string): boolean {
  if (repository.length > MAX_REPOSITORY_FILTER_LENGTH || !isOwnerRepo(repository)) return false;
  const [owner, name] = repository.split("/");
  return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}

export function prsRouter(deps: PrsApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const q = buildPrQueue(deps.prs);
    const repo = (c.req.query("repo") ?? "").trim();
    const author = (c.req.query("author") ?? "").trim();
    if (!repo && !author) return c.json(q);

    // repo / author filter は flat queue + grouped 双方に適用する.
    const match = (r: { repo_origin: string; author_session_id: string | null }) =>
      (!repo || r.repo_origin === repo) && (!author || r.author_session_id === author);
    const filtered = {
      ...q,
      grouped: {
        ready: q.grouped.ready.filter(match),
        needs_review: q.grouped.needs_review.filter(match),
        in_progress: q.grouped.in_progress.filter(match),
        merged_recent: q.grouped.merged_recent.filter(match),
      },
      queue: q.queue.filter(match),
    };
    filtered.counts = {
      ready: filtered.grouped.ready.length,
      needs_review: filtered.grouped.needs_review.length,
      in_progress: filtered.grouped.in_progress.length,
      merged_recent: filtered.grouped.merged_recent.length,
      total_active: filtered.queue.length,
    };
    return c.json(filtered);
  });

  app.get("/digest", (c) => {
    const q = buildPrQueue(deps.prs);
    return c.json({ markdown: renderPrQueueMarkdown(q) });
  });

  /**
   * GET /v1/prs/revisor — Revisor (ローカル PR レビューサービス) の local PR 一覧。
   *
   * GitHub の PR とは別系統 (ローカルクローン上のブランチをレビューする仕組み) なので
   * queue には混ぜず、 独立したセクションとして返す。 Revisor 未設定 / 停止中は
   * configured=false ないし error を返し、 PRs ページは GitHub 側だけ描く。
   */
  app.get("/revisor", async (c) => {
    if (!deps.revisor) {
      return c.json({ configured: false, base_url: null, pull_requests: [], error: null });
    }
    try {
      const [pullRequests, baseUrl] = await Promise.all([
        deps.revisor.listLocalPrs(),
        deps.revisor.baseUrl(),
      ]);
      return c.json({ configured: true, base_url: baseUrl, pull_requests: pullRequests, error: null });
    } catch (error) {
      // Revisor が落ちていても PRs ページ自体は開けるべきなので 200 + error で返す。
      return c.json({
        configured: true,
        base_url: null,
        pull_requests: [],
        error: error instanceof Error ? error.message : "Revisor request failed",
      });
    }
  });

  /**
   * GET /v1/prs/revisor/digest — Revisor local PR 一覧の Markdown ダイジェスト。
   *
   * Discord の /rv-prs と RWF 📋 が使う。 描画は `src/pr/local-pr-listing.ts` に
   * 一本化し、 「PR = Revisor local PR」の注記もそこが必ず付ける。 未構成・停止中も
   * 200 + 説明 markdown (無言スキップ禁止)。 クエリ: repository (任意、 owner/repo)。
   */
  app.get("/revisor/digest", async (c) => {
    const repository = (c.req.query("repository") ?? "").trim() || null;
    // Public callers only need the documented owner/repo form. Accepting local paths here would
    // let a caller associate otherwise-redacted PR titles with guessed workstation paths.
    if (repository && !isValidRepositoryFilter(repository)) {
      return c.json({ error: "repository_invalid" }, 400);
    }
    const digest = await buildRevisorLocalPrDigest(
      deps.revisor,
      { repository },
    );
    return c.json({ markdown: digest.markdown, open_count: digest.openCount, error: digest.error });
  });

  /**
   * POST /v1/prs/local — session の作業ブランチを Revisor へ local PR として提出する。
   *
   * 通常はセッション終了イベントで自動提出されるが、 終了を待たずにレビューへ出したい
   * ときの手動口。 提出しなかった場合も 200 で理由を返す (呼び出し側が「なぜ出ないか」を
   * 見られるようにする — 無言スキップが元の障害の温床だった)。
   */
  app.post("/local", async (c) => {
    if (!deps.submitLocalPr) return c.json({ error: "local_pr_submission_unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as {
      session_id?: unknown;
      fast_lane?: unknown;
    } | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    if (!sessionId) return c.json({ error: "session_id (string) required" }, 400);
    if (body?.fast_lane !== undefined && typeof body.fast_lane !== "boolean") {
      return c.json({ error: "fast_lane (boolean) required when provided" }, 400);
    }
    if (body?.fast_lane === true) {
      if (!deps.sessions) return c.json({ error: "local_pr_fast_lane_unavailable" }, 503);
      if (deps.sessions.findSession(sessionId)?.status !== "active") {
        return c.json({ error: "local_pr_fast_lane_session_inactive" }, 403);
      }
    }
    return c.json(await deps.submitLocalPr(sessionId, {
      fastLane: body?.fast_lane === true,
    }));
  });

  /**
   * POST /v1/prs/local/:id/fast-lane — queued PR を昇格する。
   *
   * 昇格は提出元セッションに限らない。提出元だけに限ると、委託先が出した PR を委託元が
   * 昇格できず、提出元セッションが終了した PR は誰も昇格できなくなる (2026-08-11 に
   * Rv #451 で発生し、Revisor CLI から迂回した)。急がせたい人と出した人は同じとは限らない。
   *
   * 共有予約枠を消費する操作なので、誰が昇格したかは session イベントに残す。呼び出し元の
   * 名乗りとして active session であることは要求する (存在しない ID での操作を通さない)。
   */
  app.post("/local/:id/fast-lane", async (c) => {
    if (!deps.revisor || !deps.sessions || !deps.revisorPromoter) {
      return c.json({ error: "local_pr_fast_lane_unavailable" }, 503);
    }
    const localPrId = c.req.param("id").trim();
    if (!localPrId) return c.json({ error: "local_pr_id required" }, 400);
    const body = await c.req.json().catch(() => null) as { session_id?: unknown } | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    if (!sessionId) return c.json({ error: "session_id (string) required" }, 400);
    if (deps.sessions.findSession(sessionId)?.status !== "active") {
      return c.json({ error: "local_pr_fast_lane_session_inactive" }, 403);
    }

    let target;
    try {
      target = (await deps.revisor.listLocalPrs()).find((pr) => pr.id === localPrId);
    } catch {
      return c.json({ error: "local_pr_fast_lane_failed" }, 502);
    }
    if (!target) return c.json({ error: "local_pr_not_found" }, 404);
    if (target.status !== "open" || target.checkStatus !== "queued") {
      return c.json({ error: "local_pr_fast_lane_not_queued" }, 409);
    }
    try {
      await deps.revisorPromoter.promoteLocalPr(localPrId, sessionId);
    } catch {
      return c.json({ error: "local_pr_fast_lane_failed" }, 502);
    }
    // 誰が急がせたかは、提出元と違いうるので両方残す。共有予約枠の消費者を後から辿れる。
    const audit = {
      local_pr_id: localPrId,
      session_id: sessionId,
      submitted_by: target.sessionId ?? null,
      by_submitter: target.sessionId === sessionId,
    };
    log.info(audit, "local PR promoted to fast lane");
    deps.sessions.appendEvent({
      session_id: sessionId,
      ts: Math.floor(Date.now() / 1000),
      kind: "pr-fast-lane",
      payload: audit,
    });
    return c.json({ promoted: true, local_pr_id: localPrId });
  });

  /**
   * POST /v1/prs/local/:id/merge — 人間の指示で、 同じプロジェクトの session が local PR をマージする。
   *
   * マージは人間の判断が要る操作である。 session が自分の判断で (Genius や他の AI の
   * 助言を含め) マージすることは無い。 したがって「直近の人間指示者を解決できること」と
   * その人の `merge_pr` は必須のまま残す。
   *
   * プロジェクト一致はそこに **追加** する制約で、 認可の代わりではない。 指示者が権限を
   * 持っていても、 他プロジェクトの PR を横から落とせないようにする。
   */
  app.post("/local/:id/merge", async (c) => {
    const sessions = deps.sessions;
    // 読み取り口が無い構成では PR の所属プロジェクトを確認できない。 確認できないまま
    // マージを通さない (プロジェクト一致が認可の土台なので、 これは可用性ではなく認可の問題)。
    if (!sessions || !deps.staff || !deps.revisorMerger || !deps.revisor) {
      return c.json({ error: "local_pr_merge_unavailable" }, 503);
    }
    const localPrId = c.req.param("id").trim();
    if (!localPrId) return c.json({ error: "local_pr_id required" }, 400);
    const body = await c.req.json().catch(() => null) as { session_id?: unknown } | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    if (!sessionId) return c.json({ error: "session_id (string) required" }, 400);

    // 人間の指示があったことが前提。 直近 100 件では、 長いセッションで最後の人間 inject が
    // 窓から押し出され、 同じセッションでもマージできたりできなかったりしていた。
    // inject だけを全期間から引き、 「指示が無い」と「窓から溢れた」を混同しない。
    const requester = lastHumanRequester(sessions.eventsByKind(sessionId, "inject"));
    if (!requester) return c.json({ error: "merge_authorizer_unknown" }, 403);

    const authorization = authorizeStaffCapability(deps.staff, requester.platform, requester.userId, "merge_pr");
    if (!authorization.allowed) {
      return c.json({ error: "merge_not_authorized", detail: authorization.detail }, 403);
    }

    // 指示者の権限に加えて、 その session が対象 PR のプロジェクトで作業していることを要求する。
    // どの project の PR かは Revisor が正本。 session 側の申告だけで突き合わせない。
    const session = sessions.findSession(sessionId);
    const targetPr = await findLocalPrById(deps.revisor, localPrId);
    const scope = decideSessionMergeScope({
      sessionFound: session !== null,
      sessionRepoOrigin: session?.repo_origin ?? null,
      localPrRepository: targetPr?.repository ?? null,
    });
    if (!scope.allowed) {
      log.warn(
        { local_pr_id: localPrId, session_id: sessionId, reason: scope.reason },
        "local PR merge refused: the requesting session is not working on that project",
      );
      return c.json({ error: "merge_project_scope_denied", reason: scope.reason, detail: scope.detail }, 403);
    }
    const merged = (outcome: "merged" | "already_merged" | "timed_out") => {
      const ts = Math.floor(Date.now() / 1000);
      const audit = {
        local_pr_id: localPrId,
        session_id: sessionId,
        outcome,
        project: scope.project,
        authorizer: { platform: requester.platform, user_id: requester.userId, role: authorization.role },
      };
      log.info(audit, "local PR merge request completed with session requester authorization");
      sessions.appendEvent({ session_id: sessionId, ts, kind: "pr-merged", payload: audit });
      return c.json({
        merged: true,
        local_pr_id: localPrId,
        ...(outcome === "already_merged" ? { already_merged: true } : {}),
        ...(outcome === "timed_out" ? { timed_out: true } : {}),
      });
    };
    // 要求を出す前に実状態を読む。 Test OK 到達時点で auto-merge が成立していることが
    // あり、 その PR へ明示マージを出すと Revisor は拒否する。 目的は達成済みなので、
    // 拒否を待ってから解釈するより先に確定させる。
    if (await isAlreadyMerged(deps.revisor, localPrId)) {
      log.info({ local_pr_id: localPrId, session_id: sessionId }, "local PR was already merged; skipping merge request");
      return merged("already_merged");
    }

    try {
      await deps.revisorMerger.mergeLocalPr(localPrId);
    } catch (error) {
      const failure = classifyMergeFailure(error);
      // 事前確認の直後に auto-merge が成立する競合があり得る。この場合は要求だけが
      // 遅れたので、Revisor の 409 を API の失敗として返さない。
      if (failure.reason === "already_merged") {
        return merged("already_merged");
      }
      // 打ち切りは「失敗」ではなく「結果不明」。 Revisor 側は処理を続けているので、
      // 実状態を読み直してから確定させる。
      if (failure.reason === "timeout" && await isAlreadyMerged(deps.revisor, localPrId)) {
        log.info(
          { local_pr_id: localPrId, session_id: sessionId },
          "local PR merge timed out on the client but Revisor completed it",
        );
        return merged("timed_out");
      }
      // 生の失敗内容は credentials / endpoint / ローカルパスを含み得るため、分類にだけ使い、
      // API 応答にも永続ログにも残さない。status と型は Revisor 側ログとの突合に使える。
      // 成功へ確定した競合・timeout は上で返しているので、失敗として警告しない。
      log.warn(
        {
          local_pr_id: localPrId,
          session_id: sessionId,
          reason: failure.reason,
          revisor_status: error instanceof RevisorMergeError ? error.status : null,
          timed_out: error instanceof RevisorMergeError && error.timedOut,
          error_type: error instanceof RevisorMergeError
            ? "RevisorMergeError"
            : error instanceof Error ? "Error" : typeof error,
        },
        "local PR merge failed",
      );
      return c.json({ error: "local_pr_merge_failed", reason: failure.reason, detail: failure.detail }, 502);
    }

    return merged("merged");
  });

  /**
   * POST /v1/prs/local/:id/close — session の直近人間指示者の権限で local PR を取り下げる。
   *
   * 認可はマージと同一 (merge_pr)。 取り下げは board から候補を消す破壊的操作で、 誤って
   * 取り下げると変更が main に入らないまま見えなくなるため、 マージより弱い権限で通して
   * よい理由が無い。
   *
   * 逆に、 マージより**強い**制限 (自セッションが作った PR に限る等) も付けない。 board の
   * 整理は「既に main に入っていて出す意味が無くなった他セッションの PR」を畳む作業であり、
   * 所有者に限ると用途そのものが成立しない。 マージが他セッターの PR を通せるのに取り下げ
   * だけ通せないのは、 権限モデルとしても一貫しない。
   */
  app.post("/local/:id/close", async (c) => {
    if (!deps.sessions || !deps.staff || !deps.revisorCloser) {
      return c.json({ error: "local_pr_close_unavailable" }, 503);
    }
    const localPrId = c.req.param("id").trim();
    if (!localPrId) return c.json({ error: "local_pr_id required" }, 400);
    const body = await c.req.json().catch(() => null) as {
      session_id?: unknown;
      reason?: unknown;
    } | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    if (!sessionId) return c.json({ error: "session_id (string) required" }, 400);
    const reason = typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, MAX_CLOSE_REASON_LENGTH)
      : undefined;

    const requester = lastHumanRequester(deps.sessions.recentEvents(sessionId, 100));
    if (!requester) return c.json({ error: "close_authorizer_unknown" }, 403);

    const authorization = authorizeStaffCapability(deps.staff, requester.platform, requester.userId, "merge_pr");
    if (!authorization.allowed) {
      return c.json({ error: "close_not_authorized", detail: authorization.detail }, 403);
    }
    try {
      await deps.revisorCloser.closeLocalPr(localPrId, reason);
    } catch {
      // Revisor の生の失敗内容は endpoint / 設定情報を含み得るので、ローカル API を経由して返さない。
      return c.json({ error: "local_pr_close_failed", detail: "Revisor local PR close failed" }, 502);
    }

    const ts = Math.floor(Date.now() / 1000);
    const audit = {
      local_pr_id: localPrId,
      session_id: sessionId,
      reason: reason ?? null,
      authorizer: { platform: requester.platform, user_id: requester.userId, role: authorization.role },
    };
    log.info(audit, "local PR closed with session requester authorization");
    deps.sessions.appendEvent({ session_id: sessionId, ts, kind: "pr-closed", payload: audit });
    return c.json({ closed: true, local_pr_id: localPrId });
  });

  /**
   * POST /v1/prs/local/direct — repo_path + branch の直指定で local PR を提出する。
   *
   * Cc セッション登録を持たない作業 (Lictor 未ラップの bg job、 終了済みセッションの
   * ブランチ、 手作業ブランチ) をレビューへ出す口。 session_id は任意で、 渡した
   * 場合だけ審査結果 inject の binding が付く。 提出しなかった場合も 200 + 理由。
   */
  app.post("/local/direct", async (c) => {
    if (!deps.submitDirectLocalPr) return c.json({ error: "local_pr_submission_unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as
      | { repo_path?: unknown; branch?: unknown; session_id?: unknown; pr_content?: unknown; fast_lane?: unknown }
      | null;
    const repoPath = typeof body?.repo_path === "string" ? body.repo_path.trim() : "";
    if (!repoPath) return c.json({ error: "repo_path (string) required" }, 400);
    const branch = typeof body?.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined;
    const sessionId = typeof body?.session_id === "string" && body.session_id.trim() ? body.session_id.trim() : undefined;
    // オブジェクト等を未指定扱いにすると、呼び出し側が意図しない自動生成本文で
    // PR が作られるため、明示された非文字列は入口で拒否する。
    if (body?.pr_content !== undefined && typeof body.pr_content !== "string") {
      return c.json({ error: "pr_content (string) required when provided" }, 400);
    }
    const prContent = typeof body?.pr_content === "string" && body.pr_content.trim()
      ? body.pr_content
      : undefined;
    if (body?.fast_lane !== undefined && typeof body.fast_lane !== "boolean") {
      return c.json({ error: "fast_lane (boolean) required when provided" }, 400);
    }
    if (body?.fast_lane === true && !sessionId) {
      return c.json({ error: "session_id required for fast_lane" }, 400);
    }
    if (body?.fast_lane === true) {
      if (!deps.sessions) return c.json({ error: "local_pr_fast_lane_unavailable" }, 503);
      if (deps.sessions.findSession(sessionId as string)?.status !== "active") {
        return c.json({ error: "local_pr_fast_lane_session_inactive" }, 403);
      }
    }
    return c.json(await deps.submitDirectLocalPr({
      repoPath,
      branch,
      sessionId,
      ...(prContent ? { prContent } : {}),
      ...(body?.fast_lane === true ? { fastLane: true } : {}),
    }));
  });

  app.get("/list", (c) => {
    const stateRaw = (c.req.query("state") ?? "").trim();
    const states = stateRaw
      ? stateRaw.split(",").map((s) => s.trim()).filter((s): s is PrState => VALID_STATES.includes(s as PrState))
      : undefined;
    const repo = (c.req.query("repo") ?? "").trim() || undefined;
    const author = (c.req.query("author") ?? "").trim() || undefined;
    const limitRaw = Number(c.req.query("limit") ?? "");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
    const items = deps.prs.list({ states, repo_origin: repo, author_session_id: author, limit });
    return c.json({ items });
  });

  return app;
}
