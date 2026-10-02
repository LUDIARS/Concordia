/**
 * 月次予算の起動時の判定 (spec/feature/usage-budgets.md §5) の結合確認。
 * admin spawn が、 依頼者 (またはチーム) の予算を使い切っていれば起動しない。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../src/control/spawner.js";
import { makeTestApp } from "./helpers/test-app.js";

const REQUESTER = "123456789012";

describe("usage budget at admin spawn", () => {
  let env: ReturnType<typeof makeTestApp>;
  let spawnCalls: SpawnRequest[];

  beforeEach(() => {
    spawnCalls = [];
    env = makeTestApp({
      usageBudgets: { readUsage: async () => ({ total: 1_000 }) },
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 1, command: ["wt.exe"] };
      },
    });
    env.adminState.setWorkspaceRoot(env.logsDir);
    // 今月、 この依頼者が起こしたセッションが 1 本ある (1,000 トークン消費)。
    env.repo.insertSession({
      id: "earlier", provider: "claude", repo_path: env.logsDir, repo_origin: null, branch: null, host: "h",
      started_at: Math.floor(Date.now() / 1000), last_seen_at: Math.floor(Date.now() / 1000), transcript_path: null,
      metadata: JSON.stringify({ discord_requester_user_id: REQUESTER }),
    });
  }, 30_000);

  const spawn = (body: Record<string, unknown>) => Promise.resolve(env.app.request("/v1/admin/spawn-session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const setBudget = (scope: string, id: string, limit: number) => Promise.resolve(env.app.request(`/v1/usage-budgets/${scope}/${id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit_tokens: limit }),
  }));

  it("launches while the requester has budget left and refuses once it is used up", async () => {
    await setBudget("user", REQUESTER, 5_000);
    expect((await spawn({ provider: "claude", cwd: env.logsDir, requester_discord_user_id: REQUESTER })).status).toBe(200);
    await setBudget("user", REQUESTER, 1_000);
    const refused = await spawn({ provider: "claude", cwd: env.logsDir, requester_discord_user_id: REQUESTER });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: string }).error).toMatch(/^budget_exhausted: あなたの今月の予算を使い切りました/);
    expect(spawnCalls).toHaveLength(1);
  });

  it("launches without any budget configured (unlimited)", async () => {
    expect((await spawn({ provider: "claude", cwd: env.logsDir, requester_discord_user_id: REQUESTER })).status).toBe(200);
  });
});
