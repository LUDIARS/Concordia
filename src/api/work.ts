/**
 * /v1/work — 横断的な作業ログ集約 API.
 *
 * Web の Work ページが叩く. session-detail のように 1 セッションに閉じず、
 * 「全体 (or 指定 repo) で AI がいま何をしているか」 を 1 リクエストで取れる.
 *
 *  GET /v1/work/conversations
 *    クエリ:
 *      - repo_path        : sessions.repo_path で完全一致 filter (省略=全 repo)
 *      - repo_origin      : sessions.repo_origin で完全一致 filter (省略=全 repo)
 *      - status           : "active" | "ended" | "lost" | "abandoned" (省略=全 status)
 *      - limit_per_session: 1..500 (default 100). 1 session あたり拾う frame 数
 *      - max_sessions     : 1..100 (default 30).  返す session 数の上限
 *
 *    レスポンス:
 *      {
 *        available_repos: [{ repo_path, repo_origin?, session_count }],
 *        sessions: [{ session: SessionRow, conversation: TranscriptLogEntry[] }]
 *      }
 *      conversation は kind="text" + payload.role ∈ {user, assistant} のみに filter 済.
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TranscriptLogsRepo, TranscriptLogEntry } from "../db/transcript-logs-repo.js";
import { serializeSession } from "./sessions.js";
import { scanReposMulti } from "../work/repo-scan.js";

export interface WorkApiDeps {
  sessions: SessionsRepo;
  transcriptLogs: TranscriptLogsRepo;
  /**
   * ローカルクローンを走査する作業ルート群 (AdminState 由来)。 設定 GUI から
   * 複数ルートを編集できるよう、 呼び出し毎に live 解決する。
   */
  resolveWorkspaceRoots: () => string[];
}

export function workRouter(deps: WorkApiDeps): Hono {
  const app = new Hono();

  // GET /v1/work/repos — 各作業ルート直下の各リポの branch / worktree / session 一覧。
  app.get("/repos", async (c) => {
    const roots = deps.resolveWorkspaceRoots();
    const repos = await scanReposMulti(roots, deps.sessions);
    // root は後方互換のためプライマリ (先頭) を返す。 roots に全ルートを載せる。
    return c.json({ root: roots[0] ?? "", roots, repos });
  });

  app.get("/conversations", (c) => {
    const q = c.req.query();
    const repoPath = (q.repo_path ?? "").trim();
    const repoOrigin = (q.repo_origin ?? "").trim();
    const status = (q.status ?? "").trim();
    const limitPerSession = clamp(Number(q.limit_per_session ?? "100"), 1, 500, 100);
    const maxSessions = clamp(Number(q.max_sessions ?? "30"), 1, 100, 30);

    // 1. 母集団 — status filter は repo に依存しないので前段で適用
    let pool = deps.sessions.listSessions(
      status && ["active", "ended", "lost", "abandoned"].includes(status)
        ? { status: status as "active" | "ended" | "lost" | "abandoned" }
        : {},
    );

    // 2. repo filter (repo_path / repo_origin 完全一致)
    let filtered = pool;
    if (repoPath) filtered = filtered.filter((s) => s.repo_path === repoPath);
    if (repoOrigin) filtered = filtered.filter((s) => s.repo_origin === repoOrigin);

    // 3. 最新順から上限まで
    filtered = filtered.slice(0, maxSessions);

    // 4. 各 session について conversation (text + user/assistant) を抽出
    const sessions = filtered.map((s) => {
      const entries = deps.transcriptLogs.listBySession(s.id, { limit: limitPerSession });
      const conversation = entries.filter(isConversationEntry);
      return { session: serializeSession(s), conversation };
    });

    // 5. repo chip 用に「全 status を通した repo 一覧」 を作る
    //    repo filter 適用前の pool は status filter で絞られているので、
    //    chip としては「ステータス問わない全 repo」 を出したい. そのため
    //    listSessions({}) を別途引く.
    const allForChips = deps.sessions.listSessions({});
    const repoCounts = new Map<string, { repo_path: string; repo_origin: string | null; session_count: number }>();
    for (const s of allForChips) {
      const key = s.repo_path;
      const existing = repoCounts.get(key);
      if (existing) existing.session_count += 1;
      else repoCounts.set(key, { repo_path: s.repo_path, repo_origin: s.repo_origin, session_count: 1 });
    }
    const available_repos = [...repoCounts.values()].sort(
      (a, b) => b.session_count - a.session_count,
    );

    return c.json({
      filter: { repo_path: repoPath || null, repo_origin: repoOrigin || null, status: status || null },
      available_repos,
      sessions,
    });
  });

  return app;
}

function isConversationEntry(e: TranscriptLogEntry): boolean {
  if (e.kind !== "text") return false;
  const p = e.payload as { role?: unknown } | null;
  if (!p || typeof p !== "object") return false;
  return p.role === "user" || p.role === "assistant";
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
