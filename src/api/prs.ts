/**
 * /v1/prs — PR キュー API.
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
 * 認証は loopback 想定で無し (他 /v1 と同じ).
 */

import { Hono } from "hono";
import type { PrRecordsRepo, PrState } from "../db/pr-records-repo.js";
import { buildPrQueue } from "../pr/queue.js";
import { renderPrQueueMarkdown } from "../pr/render.js";

export interface PrsApiDeps {
  prs: PrRecordsRepo;
  /**
   * session の作業ブランチを Revisor の local PR として提出する。 未注入なら
   * POST /v1/prs/local は生えない (レビュー発火なしの構成)。
   */
  submitLocalPr?: (sessionId: string) => Promise<
    | { submitted: true; pullRequest: { id: string; number: number; repository: string } }
    | { submitted: false; reason: string; detail?: string }
  >;
}

const VALID_STATES: PrState[] = ["draft", "open", "merged", "closed"];

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
