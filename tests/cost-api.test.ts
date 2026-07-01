import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";
import { CostUsageSamplesRepo } from "../src/db/cost-usage-samples-repo.js";
import { CostLimitSamplesRepo } from "../src/db/cost-limit-samples-repo.js";

describe("/v1/cost", () => {
  let env: TestAppEnv;
  beforeEach(() => {
    env = makeTestApp();
  });

  it("GET /overview は本社/子会社ウィンドウ + チャンネル別を返す", async () => {
    env.repo.insertSession({
      id: "s1", provider: "claude-code", repo_path: "/x", repo_origin: null, branch: null,
      host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
    });
    const res = await env.app.request("/v1/cost/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.windows).toBeTruthy();
    expect(body.windows.daily.headOffice.name).toBe("本社");
    expect(Array.isArray(body.channels)).toBe(true);
    // active セッション s1 が channel 行に乗る (ログ未発見なので context=null/cost=0)。
    expect(body.channels.some((c: any) => c.sessionId === "s1")).toBe(true);
  });

  it("GET /timeseries は記録済みサンプルをバケット集計して返す", async () => {
    const samples = new CostUsageSamplesRepo(env.db);
    samples.insertMany([
      { ts: 1000, session_id: "s1", subsidiary_id: null, provider: "claude-code", context_tokens: 50000, cost_tokens: 1000 },
      { ts: 1300, session_id: "s1", subsidiary_id: null, provider: "claude-code", context_tokens: 60000, cost_tokens: 1500 },
    ]);
    const res = await env.app.request("/v1/cost/timeseries?since=0&bucket=1000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.bucketSec).toBe(1000);
    // bucket 1000: 2 サンプル → spent = 0(baseline)+500、 context = 110000
    expect(body.points).toHaveLength(1);
    expect(body.points[0]).toMatchObject({ ts: 1000, sessions: 1, contextTokens: 110000, spentTokens: 500 });
    expect(body.providers["claude-code"][0]).toMatchObject({ ts: 1000, sessions: 1, spentTokens: 500 });
  });

  it("GET /timeseries は since より古いサンプルを除外する", async () => {
    const samples = new CostUsageSamplesRepo(env.db);
    samples.insert({ ts: 500, session_id: "old", subsidiary_id: null, provider: "claude-code", context_tokens: 1, cost_tokens: 1 });
    samples.insert({ ts: 5000, session_id: "new", subsidiary_id: null, provider: "claude-code", context_tokens: 1, cost_tokens: 1 });
    const res = await env.app.request("/v1/cost/timeseries?since=1000&bucket=1000");
    const body = (await res.json()) as any;
    const sessionsSeen = new Set(body.points.flatMap((p: any) => p.sessions));
    expect(body.points.every((p: any) => p.ts >= 1000)).toBe(true);
    expect(body.points.length).toBe(1); // new のみ
  });

  it("GET /limit-timeseries returns provider limit percentage history", async () => {
    const samples = new CostLimitSamplesRepo(env.db);
    samples.insert({ ts: 1000, provider: "codex-cli", plan: "pro", used_5h_pct: 12, used_weekly_pct: 34, reset_5h_at: 2000, reset_weekly_at: 3000 });
    samples.insert({ ts: 1600, provider: "codex-cli", plan: "pro", used_5h_pct: 18, used_weekly_pct: 40, reset_5h_at: 2000, reset_weekly_at: 3000 });
    samples.insert({ ts: 500, provider: "claude-code", plan: null, used_5h_pct: 1, used_weekly_pct: 2, reset_5h_at: null, reset_weekly_at: null });

    const res = await env.app.request("/v1/cost/limit-timeseries?since=900");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.points).toHaveLength(2);
    expect(body.providers["codex-cli"].slice(0, 2).map((p: any) => p.usedWeeklyPct)).toEqual([34, 40]);
    expect(body.providers["codex-cli"][0].plan).toBe("pro");
    expect(body.providers["claude-code"]).toBeUndefined();
  });
});
