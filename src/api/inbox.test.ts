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

    expect(await res.json()).toEqual({ count: 0, items: [] });
  });
});
