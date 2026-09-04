import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { InboxItem } from "../inbox/read-model.js";
import type { InboxItemState } from "../db/inbox-item-state-repo.js";

/**
 * `GET /v1/inbox` — 人間宛て未回答事項の統合一覧。
 *
 * 読み取り専用。 回答・解決は既存経路 (answer-question / confirm / director API) のままで、
 * ここは状態を持たない。 持つと、 どちらが正なのか分からなくなる。
 *
 * 既読・スヌーズだけは別で、 **client (ブラウザ) ごとの UI 状態**として持つ
 * (`POST /v1/inbox/:key/read` / `:key/snooze`)。 これは「誰が答えたか」ではなく
 * 「自分がもう見たか」なので、 正本の状態には影響しない。
 *
 * DB は直接持たない。 この API は他のルートと同じく、 読み取り関数を注入される
 * (テストで DB を立てずに契約だけ見られる)。
 *
 * @implements spec/feature/approval-inbox.md §2
 */
export interface InboxApiDeps {
  items: () => InboxItem[];
  now?: () => number;
  /** client ごとの UI 状態。 未注入なら既読・スヌーズを持たない (state は常に空)。 */
  itemState?: {
    allFor: (clientId: string) => Map<string, InboxItemState>;
    markRead: (clientId: string, itemKey: string, at: number) => void;
    markUnread: (clientId: string, itemKey: string, at: number) => void;
    snooze: (clientId: string, itemKey: string, at: number, until: number | null) => void;
    pruneMissing: (liveKeys: ReadonlySet<string>) => number;
  };
}

const ClientIdSchema = z.string().trim().min(1).max(128).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  { message: "client_id must not contain control characters" },
);
const ReadBodySchema = z.object({ read: z.boolean().optional() });
const SnoozeBodySchema = z.object({ until: z.number().finite().nullable() });

/** client_id はブラウザ生成の opaque ID。 session_messages と同じ上限で受ける。 */
function clientIdOf(raw: string | undefined): string | null {
  const parsed = ClientIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function inboxRouter(deps: InboxApiDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  app.get("/", (c) => {
    const at = now();
    const items = deps.items();
    const rawClientId = c.req.query("client_id");
    const clientId = clientIdOf(rawClientId);
    if (rawClientId !== undefined && !clientId) {
      return c.json({ error: "invalid client_id (query)" }, 400);
    }
    if (deps.itemState) deps.itemState.pruneMissing(new Set(items.map((item) => item.key)));
    const state = clientId && deps.itemState
      ? deps.itemState.allFor(clientId)
      : new Map<string, InboxItemState>();
    // Human questions can contain operational context; browsers and proxies must not retain it.
    c.header("cache-control", "no-store");
    const rows = items.map((item) => {
      const own = state.get(item.key) ?? null;
      const snoozedUntil = own?.snoozedUntil ?? null;
      return {
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
        read_at: own?.readAt ?? null,
        snoozed_until: snoozedUntil,
        snoozed: snoozedUntil !== null && snoozedUntil > at,
      };
    });
    return c.json({
      // 「いま何件あるのか」がまず要る。 0 件なら見に行かなくてよい。
      // **スヌーズしても count は減らさない** — 未回答の実数を UI 状態でごまかさない。
      count: rows.length,
      // 表示用。 いま画面に出すべき件数はこちら。
      active_count: rows.filter((row) => !row.snoozed).length,
      items: rows,
    });
  });

  app.post("/:key/read", async (c) => {
    const input = mutationInput(c, deps);
    if (!input.ok) return input.response;
    const body = await optionalJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = ReadBodySchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const at = now();
    if (parsed.data.read === false) input.itemState.markUnread(input.clientId, input.itemKey, at);
    else input.itemState.markRead(input.clientId, input.itemKey, at);
    return c.json({ ok: true });
  });

  app.post("/:key/snooze", async (c) => {
    const input = mutationInput(c, deps);
    if (!input.ok) return input.response;
    const body = await optionalJson(c);
    if (!body.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = SnoozeBodySchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    // null は解除。 過去時刻も解除と同じ意味になる (読み出し側が now と比べるため)。
    input.itemState.snooze(input.clientId, input.itemKey, now(), parsed.data.until);
    return c.json({ ok: true });
  });

  return app;
}

type ItemState = NonNullable<InboxApiDeps["itemState"]>;
type MutationInput =
  | { ok: true; clientId: string; itemKey: string; itemState: ItemState }
  | { ok: false; response: Response };

function mutationInput(c: Context, deps: InboxApiDeps): MutationInput {
  if (!deps.itemState) {
    return { ok: false, response: c.json({ error: "inbox item state is not available" }, 503) };
  }
  const clientId = clientIdOf(c.req.query("client_id"));
  if (!clientId) {
    return { ok: false, response: c.json({ error: "valid client_id (query) required" }, 400) };
  }
  const itemKey = String(c.req.param("key") ?? "").trim();
  if (!itemKey || itemKey.length > 400) {
    return { ok: false, response: c.json({ error: "valid item key required" }, 400) };
  }
  if (!deps.items().some((item) => item.key === itemKey)) {
    return { ok: false, response: c.json({ error: "inbox item not found" }, 404) };
  }
  return { ok: true, clientId, itemKey, itemState: deps.itemState };
}

type OptionalJson = { ok: true; value: unknown } | { ok: false };

async function optionalJson(c: Context): Promise<OptionalJson> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
