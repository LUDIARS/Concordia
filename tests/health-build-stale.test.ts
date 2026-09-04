/**
 * `/health` が dist の鮮度を出すことの回帰テスト。
 *
 * 「main に入っているのに直らない」は原因が見えにくく、毎回 dist と src の mtime を
 * 手で比べて気づいていた (Memoria #2000 / #1996)。health から見えるのが本題なので、
 * 判定そのもの (build-freshness.test.ts) とは別に応答へ載ることを固定する。
 */

import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

describe("GET /health の build_stale", () => {
  it("既定では false を返す", async () => {
    const env = makeTestApp();
    const res = await env.app.request("/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; build_stale: boolean };
    expect(body.ok).toBe(true);
    expect(body.build_stale).toBe(false);
  });

  it("古いビルドで稼働していても ok は落とさない", async () => {
    // 動いてはいるので「壊れている」ではない。ok を落とすと Excubitor の
    // health チェックが再起動を始め、古い dist のまま再起動を繰り返すだけになる。
    const env = makeTestApp({ buildStale: true });
    const res = await env.app.request("/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; build_stale: boolean };
    expect(body.ok).toBe(true);
    expect(body.build_stale).toBe(true);
  });
});
