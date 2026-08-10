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
 * 認証は loopback 想定で無し (他 /v1 と同じ).
 */

import { Hono } from "hono";
import type { PrRecordsRepo, PrState } from "../db/pr-records-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { StaffRepo } from "../db/staff-repo.js";
import { buildPrQueue } from "../pr/queue.js";
import { renderPrQueueMarkdown } from "../pr/render.js";
import type {
  RevisorLocalPrCloser,
  RevisorLocalPrMerger,
  RevisorLocalPrReader,
} from "../pr/revisor-client.js";
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
  submitLocalPr?: (sessionId: string) => Promise<
    | { submitted: true; pullRequest: { id: string; number: number; repository: string } }
    | { submitted: false; resubmitted: true; pullRequest: { id: string; number: number; repository: string } }
    | { submitted: false; reason: string; detail?: string }
  >;
  /** session の直近人間指示者を監査付きマージの認可者として解決する。 */
  sessions?: Pick<SessionsRepo, "recentEvents" | "appendEvent">;
  /** platform ごとの staff role を live 参照する。 */
  staff?: Pick<StaffRepo, "roleOf">;
  /** Revisor local PR の変更操作。未注入時は fail-closed。 */
  revisorMerger?: RevisorLocalPrMerger;
  /** Revisor local PR の取り下げ操作。未注入時は fail-closed。 */
  revisorCloser?: RevisorLocalPrCloser;
  /**
   * session 非依存の direct 提出 (repo_path + branch)。 未注入なら
   * POST /v1/prs/local/direct は 503。
   */
  submitDirectLocalPr?: (request: {
    repoPath: string;
    branch?: string;
    sessionId?: string;
    prContent?: string;
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
   * POST /v1/prs/local — session の作業ブランチを Revisor へ local PR として提出する。
   *
   * 通常はセッション終了イベントで自動提出されるが、 終了を待たずにレビューへ出したい
   * ときの手動口。 提出しなかった場合も 200 で理由を返す (呼び出し側が「なぜ出ないか」を
   * 見られるようにする — 無言スキップが元の障害の温床だった)。
   */
  app.post("/local", async (c) => {
    if (!deps.submitLocalPr) return c.json({ error: "local_pr_submission_unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as { session_id?: unknown } | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    if (!sessionId) return c.json({ error: "session_id (string) required" }, 400);
    return c.json(await deps.submitLocalPr(sessionId));
  });

  /**
   * POST /v1/prs/local/:id/merge — session の直近人間指示者の権限で local PR をマージする。
   * 指示者や capability を解決できない構成は、実行せず明示的に deny する。
   */
  app.post("/local/:id/merge", async (c) => {
    if (!deps.sessions || !deps.staff || !deps.revisorMerger) {
      return c.json({ error: "local_pr_merge_unavailable" }, 503);
    }
    const localPrId = c.req.param("id").trim();
    if (!localPrId) return c.json({ error: "local_pr_id required" }, 400);
    const body = await c.req.json().catch(() => null) as { session_id?: unknown } | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    if (!sessionId) return c.json({ error: "session_id (string) required" }, 400);

    const requester = lastHumanRequester(deps.sessions.recentEvents(sessionId, 100));
    if (!requester) return c.json({ error: "merge_authorizer_unknown" }, 403);

    const authorization = authorizeStaffCapability(deps.staff, requester.platform, requester.userId, "merge_pr");
    if (!authorization.allowed) {
      return c.json({ error: "merge_not_authorized", detail: authorization.detail }, 403);
    }
    try {
      await deps.revisorMerger.mergeLocalPr(localPrId);
    } catch {
      // Revisor の生の失敗内容は endpoint / 設定情報を含み得るので、ローカル API を経由して返さない。
      return c.json({ error: "local_pr_merge_failed", detail: "Revisor local PR merge failed" }, 502);
    }

    const ts = Math.floor(Date.now() / 1000);
    const audit = {
      local_pr_id: localPrId,
      session_id: sessionId,
      authorizer: { platform: requester.platform, user_id: requester.userId, role: authorization.role },
    };
    log.info(audit, "local PR merged with session requester authorization");
    deps.sessions.appendEvent({ session_id: sessionId, ts, kind: "pr-merged", payload: audit });
    return c.json({ merged: true, local_pr_id: localPrId });
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
      | { repo_path?: unknown; branch?: unknown; session_id?: unknown; pr_content?: unknown }
      | null;
    const repoPath = typeof body?.repo_path === "string" ? body.repo_path.trim() : "";
    if (!repoPath) return c.json({ error: "repo_path (string) required" }, 400);
    const branch = typeof body?.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined;
    const sessionId = typeof body?.session_id === "string" && body.session_id.trim() ? body.session_id.trim() : undefined;
    const prContent = typeof body?.pr_content === "string" && body.pr_content.trim()
      ? body.pr_content
      : undefined;
    return c.json(await deps.submitDirectLocalPr({ repoPath, branch, sessionId, prContent }));
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
