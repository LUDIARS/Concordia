/**
 * ワークフロー個別有効化フラグの API 面。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W1-1 / W1-4 / W6
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";
import { WORKFLOW_KEYS, type WorkflowKey } from "../src/workflow/keys.js";

/** ワークフローごとの代表 API (無効時に 409 を返すべき経路)。 */
const GATED_ROUTES: Array<{ key: WorkflowKey; path: string }> = [
  { key: "task", path: "/v1/taskflow/overview" },
  { key: "test", path: "/v1/testing/claims" },
  { key: "review", path: "/v1/prs" },
  { key: "daily", path: "/v1/daily-reports" },
  { key: "cost", path: "/v1/cost/overview" },
  { key: "reaction", path: "/v1/admin/reaction-mappings" },
];

describe("GET /v1/admin/workflows", () => {
  let env: TestAppEnv;
  beforeEach(() => { env = makeTestApp(); });

  it("既定では全ワークフローが有効 (source=default)", async () => {
    const r = await env.app.request("/v1/admin/workflows");
    expect(r.status).toBe(200);
    const body = await r.json() as { workflows: Record<string, { enabled: boolean; source: string }> };
    for (const key of WORKFLOW_KEYS) {
      expect(body.workflows[key], `workflow.${key}`).toEqual({ enabled: true, source: "default" });
    }
  });

  it("PUT で無効化すると DB 由来として反映される", async () => {
    const r = await env.app.request("/v1/admin/workflows/task", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ workflow: "task", enabled: false, source: "db" });
    expect(env.adminState.isWorkflowEnabled("task")).toBe(false);
  });

  it("未知のワークフローキーは 404", async () => {
    const r = await env.app.request("/v1/admin/workflows/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(r.status).toBe(404);
  });

  it("enabled が boolean でなければ 400", async () => {
    const r = await env.app.request("/v1/admin/workflows/task", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("無効ワークフローの API は 409 + 理由", () => {
  let env: TestAppEnv;
  beforeEach(() => { env = makeTestApp(); });

  /**
   * 一部の GET は HTTP レスポンスキャッシュ (src/shared/http-cache.ts) に乗る。
   * ゲートの即時性を見たいので、 キャッシュは明示的にバイパスする。
   */
  const fetchUncached = (path: string) =>
    env.app.request(path, { headers: { "cache-control": "no-cache" } });

  for (const { key, path } of GATED_ROUTES) {
    it(`${path} は workflow.${key} が無効なら 409 を返す (404 にしない)`, async () => {
      const before = await fetchUncached(path);
      expect(before.status, `${path} は既定で有効なはず`).not.toBe(409);

      env.adminState.setWorkflowEnabled(key, false);

      const after = await fetchUncached(path);
      expect(after.status).toBe(409);
      const body = await after.json() as {
        error: string;
        workflow: string;
        reason: string;
        setting_key: string;
        env_name: string;
      };
      expect(body.error).toBe("workflow_disabled");
      expect(body.workflow).toBe(key);
      expect(body.reason).toContain("設定で無効");
      expect(body.setting_key).toBe(`admin.workflow.${key}.enabled`);
      expect(body.env_name).toBe(`CONCORDIA_WORKFLOW_${key.toUpperCase()}_ENABLED`);
    });
  }

  it("設定変更は再起動なしで次のリクエストから効く (両方向)", async () => {
    expect((await fetchUncached("/v1/prs")).status).not.toBe(409);

    env.adminState.setWorkflowEnabled("review", false);
    expect((await fetchUncached("/v1/prs")).status).toBe(409);

    env.adminState.setWorkflowEnabled("review", true);
    expect((await fetchUncached("/v1/prs")).status).not.toBe(409);
  });

  it("あるワークフローの無効化は他のワークフローの API に波及しない", async () => {
    env.adminState.setWorkflowEnabled("task", false);
    expect((await fetchUncached("/v1/taskflow/overview")).status).toBe(409);
    expect((await fetchUncached("/v1/prs")).status).not.toBe(409);
    expect((await fetchUncached("/v1/cost/overview")).status).not.toBe(409);
  });
});

describe("PUT /v1/admin/reaction-mappings", () => {
  for (const emoji of ["👌", "👌️", "👌🏽"]) {
    it(`予約済みの ${emoji} は workflow action に割り当てられない`, async () => {
      const env = makeTestApp();
      const response = await env.app.request("/v1/admin/reaction-mappings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji, action: "handoff-document" }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "body.emoji is reserved as non-actionable" });
      expect(env.adminState.getReactionEmojiOverrides()).not.toHaveProperty(emoji);
    });
  }
});
