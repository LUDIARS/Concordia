/**
 * @implements spec/feature/usage-budgets.md §9
 * コスト画面の `GET /v1/cost/session-caps` が会社ごとの稼働数と上限をそのまま返すことを確かめる。
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { costRouter } from "./cost.js";

describe("GET /v1/cost/session-caps", () => {
  it("returns each company's running sessions and cap", async () => {
    const companies = [
      { subsidiary_id: null, name: "本社", active: 3, max: 30, reached: false },
      { subsidiary_id: "s1", name: "alpha", active: 1, max: 0, reached: false },
    ];
    const app = new Hono().route("/v1/cost", costRouter({
      sessions: {} as never,
      resolveSessionChannelId: () => null,
      samples: {} as never,
      limitSamples: {} as never,
      oneShots: {} as never,
      listSubsidiaries: () => [],
      listSessionCaps: () => companies,
    }));
    const res = await app.request("/v1/cost/session-caps");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companies });
  });

  it("returns an empty list when the caps are not wired", async () => {
    const app = new Hono().route("/v1/cost", costRouter({
      sessions: {} as never,
      resolveSessionChannelId: () => null,
      samples: {} as never,
      limitSamples: {} as never,
      oneShots: {} as never,
      listSubsidiaries: () => [],
    }));
    expect(await (await app.request("/v1/cost/session-caps")).json()).toEqual({ companies: [] });
  });
});
