import { Hono } from "hono";
import type { InboxItem } from "../inbox/read-model.js";

/**
 * `GET /v1/inbox` — 人間宛て未回答事項の統合一覧。
 *
 * 読み取り専用。 回答・解決は既存経路 (answer-question / confirm / director API) のままで、
 * ここは状態を持たない。 持つと、 どちらが正なのか分からなくなる。
 *
 * DB は直接持たない。 この API は他のルートと同じく、 読み取り関数を注入される
 * (テストで DB を立てずに契約だけ見られる)。
 *
 * @implements spec/feature/approval-inbox.md §2
 */
export interface InboxApiDeps {
  items: () => InboxItem[];
  now?: () => number;
}

export function inboxRouter(deps: InboxApiDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  app.get("/", (c) => {
    const at = now();
    const items = deps.items();
    // Human questions can contain operational context; browsers and proxies must not retain it.
    c.header("cache-control", "no-store");
    return c.json({
      // 「いま何件あるのか」がまず要る。 0 件なら見に行かなくてよい。
      count: items.length,
      items: items.map((item) => ({
        key: item.key,
        kind: item.kind,
        summary: item.summary,
        raised_at: item.raisedAt,
        // 経過時間はサーバ側で出す。 クライアントごとの時計のずれで
        // 「何時間放置されているか」が変わると催促の判断がぶれる。
        elapsed_ms: Math.max(0, at - item.raisedAt),
        session_id: item.sessionId ?? null,
        case_id: item.caseId ?? null,
        repo_origin: item.repoOrigin ?? null,
        pr_number: item.prNumber ?? null,
      })),
    });
  });

  return app;
}
