/**
 * `GET /v1/inbox` の契約。
 *
 * 「いま何件あるのか」と「どれが一番放置されているか」が 1 コールで分かることが要点。
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { inboxRouter } from "./inbox.js";
import type { InboxItem } from "../inbox/read-model.js";

const ITEMS: InboxItem[] = [
  { key: "director-blocked:s1", kind: "director-blocked", summary: "分解する が blocked", raisedAt: 1000, caseId: "case-1" },
  {
    key: "confirm-pending:c1",
    kind: "confirm-pending",
    summary: "起動承認待ち",
    raisedAt: 3000,
    repoOrigin: "LUDIARS/Concordia",
    prNumber: 1364,
  },
];

function makeApp(items: InboxItem[], now = 5000): Hono {
  return new Hono().route("/v1/inbox", inboxRouter({ items: () => items, now: () => now }));
}

describe("GET /v1/inbox", () => {
  it("件数と項目を返す", async () => {
    const res = await makeApp(ITEMS).request("/v1/inbox");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { count: number; items: Array<Record<string, unknown>> };
    expect(body.count).toBe(2);
    expect(body.items[0]).toMatchObject({
      key: "director-blocked:s1",
      kind: "director-blocked",
      case_id: "case-1",
      session_id: null,
      repo_origin: null,
      pr_number: null,
    });
    expect(body.items[1]).toMatchObject({
      repo_origin: "LUDIARS/Concordia",
      pr_number: 1364,
    });
  });

  it("経過時間をサーバ側で出す", async () => {
    // クライアントごとの時計のずれで「何時間放置されているか」が変わると
    // 催促の判断がぶれる。
    const res = await makeApp(ITEMS, 5000).request("/v1/inbox");

    const body = await res.json() as { items: Array<{ elapsed_ms: number }> };
    expect(body.items[0].elapsed_ms).toBe(4000);
    expect(body.items[1].elapsed_ms).toBe(2000);
  });

  it("未来の時刻でも負にならない", async () => {
    const res = await makeApp([{ ...ITEMS[0], raisedAt: 9000 }], 5000).request("/v1/inbox");

    const body = await res.json() as { items: Array<{ elapsed_ms: number }> };
    expect(body.items[0].elapsed_ms).toBe(0);
  });

  it("0 件なら count 0 と空配列", async () => {
    const res = await makeApp([]).request("/v1/inbox");

    expect(await res.json()).toEqual({ count: 0, active_count: 0, items: [] });
  });
});

describe("既読・スヌーズ (client ごとの UI 状態)", () => {
  function makeStatefulApp(items: InboxItem[], now = 5000) {
    // 実 repo と同じ形の最小実装。 API の契約だけを見るので DB は立てない。
    const store = new Map<string, { readAt: number | null; snoozedUntil: number | null }>();
    const keyOf = (clientId: string, itemKey: string) => `${clientId}\u0000${itemKey}`;
    const patch = (
      clientId: string,
      itemKey: string,
      change: { readAt?: number | null; snoozedUntil?: number | null },
    ) => {
      const current = store.get(keyOf(clientId, itemKey)) ?? { readAt: null, snoozedUntil: null };
      store.set(keyOf(clientId, itemKey), { ...current, ...change });
    };
    const itemState = {
      allFor: (clientId: string) => {
        const out = new Map<string, { readAt: number | null; snoozedUntil: number | null }>();
        for (const [key, value] of store) {
          const [owner, itemKey] = key.split("\u0000");
          if (owner === clientId) out.set(itemKey, value);
        }
        return out;
      },
      markRead: (clientId: string, itemKey: string, at: number) => patch(clientId, itemKey, { readAt: at }),
      markUnread: (clientId: string, itemKey: string) => patch(clientId, itemKey, { readAt: null }),
      snooze: (clientId: string, itemKey: string, _at: number, until: number | null) =>
        patch(clientId, itemKey, { snoozedUntil: until }),
      pruneMissing: (liveKeys: ReadonlySet<string>) => {
        let removed = 0;
        for (const key of store.keys()) {
          const itemKey = key.slice(key.indexOf("\u0000") + 1);
          if (liveKeys.has(itemKey)) continue;
          store.delete(key);
          removed += 1;
        }
        return removed;
      },
    };
    const app = new Hono().route(
      "/v1/inbox",
      inboxRouter({ items: () => items, now: () => now, itemState }),
    );
    return { app, store };
  }

  it("既読は client ごとに分かれる", async () => {
    // 同じ未回答事項でも「自分は見た / 相方はまだ」が別々に要る。
    const { app } = makeStatefulApp(ITEMS);
    await app.request("/v1/inbox/director-blocked:s1/read?client_id=alice", { method: "POST" });

    const mine = await (await app.request("/v1/inbox?client_id=alice")).json() as any;
    const theirs = await (await app.request("/v1/inbox?client_id=bob")).json() as any;
    expect(mine.items.find((i: any) => i.key === "director-blocked:s1").read_at).toBe(5000);
    expect(theirs.items.find((i: any) => i.key === "director-blocked:s1").read_at).toBeNull();
  });

  it("既読は取り消せる", async () => {
    const { app } = makeStatefulApp(ITEMS);
    await app.request("/v1/inbox/director-blocked:s1/read?client_id=alice", { method: "POST" });
    await app.request("/v1/inbox/director-blocked:s1/read?client_id=alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: false }),
    });

    const body = await (await app.request("/v1/inbox?client_id=alice")).json() as any;
    expect(body.items.find((i: any) => i.key === "director-blocked:s1").read_at).toBeNull();
  });

  it("スヌーズしても count は減らさない (実数をごまかさない)", async () => {
    const { app } = makeStatefulApp(ITEMS);
    await app.request("/v1/inbox/director-blocked:s1/snooze?client_id=alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ until: 9000 }),
    });

    const body = await (await app.request("/v1/inbox?client_id=alice")).json() as any;
    expect(body.count).toBe(2);
    expect(body.active_count).toBe(1);
    expect(body.items.find((i: any) => i.key === "director-blocked:s1").snoozed).toBe(true);
  });

  it("期限を過ぎたスヌーズは効かない", async () => {
    const { app } = makeStatefulApp(ITEMS);
    await app.request("/v1/inbox/director-blocked:s1/snooze?client_id=alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ until: 4000 }),
    });

    const body = await (await app.request("/v1/inbox?client_id=alice")).json() as any;
    expect(body.active_count).toBe(2);
    expect(body.items.find((i: any) => i.key === "director-blocked:s1").snoozed).toBe(false);
  });

  it("既読を付けてもスヌーズは消えない", async () => {
    // 別々の操作なので、 片方が片方を巻き込まない。
    const { app } = makeStatefulApp(ITEMS);
    await app.request("/v1/inbox/director-blocked:s1/snooze?client_id=alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ until: 9000 }),
    });
    await app.request("/v1/inbox/director-blocked:s1/read?client_id=alice", { method: "POST" });

    const item = (await (await app.request("/v1/inbox?client_id=alice")).json() as any)
      .items.find((i: any) => i.key === "director-blocked:s1");
    expect(item.read_at).toBe(5000);
    expect(item.snoozed_until).toBe(9000);
  });

  it("client_id が無ければ 400", async () => {
    const { app } = makeStatefulApp(ITEMS);
    const res = await app.request("/v1/inbox/director-blocked:s1/read", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("長すぎる client_id は読み書きとも 400", async () => {
    const { app, store } = makeStatefulApp(ITEMS);
    const clientId = "x".repeat(129);

    expect((await app.request(`/v1/inbox?client_id=${clientId}`)).status).toBe(400);
    expect((await app.request(
      `/v1/inbox/director-blocked:s1/read?client_id=${clientId}`,
      { method: "POST" },
    )).status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("until が数値でなければ 400", async () => {
    const { app, store } = makeStatefulApp(ITEMS);
    const res = await app.request("/v1/inbox/director-blocked:s1/snooze?client_id=alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ until: "あとで" }),
    });
    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("存在しない item key の状態は作らない", async () => {
    const { app, store } = makeStatefulApp(ITEMS);
    const res = await app.request("/v1/inbox/unknown:1/read?client_id=alice", { method: "POST" });

    expect(res.status).toBe(404);
    expect(store.size).toBe(0);
  });

  it("壊れた JSON では状態を変更しない", async () => {
    const { app, store } = makeStatefulApp(ITEMS);
    const res = await app.request("/v1/inbox/director-blocked:s1/read?client_id=alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("until を省略した snooze は状態を変更しない", async () => {
    const { app, store } = makeStatefulApp(ITEMS);
    const res = await app.request("/v1/inbox/director-blocked:s1/snooze?client_id=alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("一覧取得時に解決済み項目の UI 状態を掃除する", async () => {
    const items = [...ITEMS];
    const { app, store } = makeStatefulApp(items);
    await app.request("/v1/inbox/director-blocked:s1/read?client_id=alice", { method: "POST" });
    items.splice(0, 1);
    await app.request("/v1/inbox?client_id=alice");

    expect(store.size).toBe(0);
  });

  it("UI 状態を持たない構成では書き込みを受け付けない", async () => {
    // 読み取り面だけで動かす構成 (worker 等) が、 黙って捨てるのを防ぐ。
    const res = await makeApp(ITEMS).request("/v1/inbox/director-blocked:s1/read?client_id=alice", {
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("client_id を渡さない一覧は従来どおり", async () => {
    const { app } = makeStatefulApp(ITEMS);
    const body = await (await app.request("/v1/inbox")).json() as any;
    expect(body.count).toBe(2);
    expect(body.active_count).toBe(2);
    expect(body.items[0].read_at).toBeNull();
  });
});
