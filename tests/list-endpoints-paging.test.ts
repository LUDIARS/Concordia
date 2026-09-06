/**
 * 一覧 API のページング / フィルタ / ペイロード縮小の回帰テスト.
 *
 * GET /v1/sessions は limit を無視して常に 200 件 + プロンプト全文入り metadata を、
 * GET /v1/delegation/runs は status を無視して全状態を返していた。 その両方を固定する。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";
import type { TestAppEnv } from "./helpers/test-app.js";

/** プロンプト全文級 metadata を持つセッションを n 件積む。 */
function seedSessions(env: TestAppEnv, n: number): void {
  for (let i = 0; i < n; i += 1) {
    env.repo.insertSession({
      id: `s-${String(i).padStart(3, "0")}`,
      provider: "claude-code",
      repo_path: "/x",
      repo_origin: "origin",
      branch: "main",
      host: "h",
      started_at: 1_000 + i,
      last_seen_at: 1_000 + i,
      transcript_path: null,
      metadata: JSON.stringify({
        role_label: "雑用係",
        discord_startup_task: "x".repeat(2_000),
        discord_startup_inject: "y".repeat(2_000),
      }),
    });
  }
}

function seedRun(env: TestAppEnv, id: string, status: "running" | "completed"): void {
  env.delegation.createRun({
    id,
    template_id: null,
    call_name: "list-test",
    target_provider: "claude",
    args: { a: 1 },
    rendered_prompt: "p".repeat(1_000),
    prompt_file_path: `/tmp/${id}.md`,
    spawn_pid: null,
    spawn_command: null,
    triggered_by: null,
    status,
  });
}

describe("GET /v1/sessions のページングと metadata 縮小", () => {
  let env: TestAppEnv;
  beforeEach(() => { env = makeTestApp(); });

  it("limit / offset を尊重し、 使った値を応答へ返す", async () => {
    seedSessions(env, 12);

    const first = await env.app.request("/v1/sessions?limit=5");
    const firstJson = await first.json() as any;
    expect(firstJson.sessions).toHaveLength(5);
    expect(firstJson.limit).toBe(5);
    expect(firstJson.offset).toBe(0);

    const second = await env.app.request("/v1/sessions?limit=5&offset=5");
    const secondJson = await second.json() as any;
    expect(secondJson.sessions).toHaveLength(5);
    expect(secondJson.offset).toBe(5);
    // started_at DESC なので 1 ページ目と 2 ページ目は重ならない。
    const firstIds = new Set(firstJson.sessions.map((s: any) => s.id));
    for (const s of secondJson.sessions) expect(firstIds.has(s.id)).toBe(false);
  });

  it("不正な limit は既定へ丸め、 上限を超えない", async () => {
    seedSessions(env, 3);
    const r = await env.app.request("/v1/sessions?limit=abc");
    const j = await r.json() as any;
    expect(j.limit).toBe(200);

    const big = await env.app.request("/v1/sessions?limit=99999");
    expect(((await big.json()) as any).limit).toBe(500);
  });

  it("空の limit / offset は未指定として扱う (1 件に潰れない)", async () => {
    seedSessions(env, 3);
    const r = await env.app.request("/v1/sessions?limit=&offset=");
    const j = await r.json() as any;
    expect(j.limit).toBe(200);
    expect(j.offset).toBe(0);
    expect(j.sessions).toHaveLength(3);
  });

  it("既定ではプロンプト全文級の metadata を落とし、 落としたキーを申告する", async () => {
    seedSessions(env, 1);
    const r = await env.app.request("/v1/sessions");
    const j = await r.json() as any;
    const s = j.sessions[0];
    expect(s.metadata.discord_startup_task).toBeUndefined();
    expect(s.metadata.discord_startup_inject).toBeUndefined();
    // 軽い判断材料は残す。
    expect(s.metadata.role_label).toBe("雑用係");
    expect(s.metadata_omitted_keys).toEqual(
      expect.arrayContaining(["discord_startup_task", "discord_startup_inject"]),
    );
  });

  it("?metadata=full なら全文を返す", async () => {
    seedSessions(env, 1);
    const r = await env.app.request("/v1/sessions?metadata=full");
    const s = ((await r.json()) as any).sessions[0];
    expect(s.metadata.discord_startup_task).toHaveLength(2_000);
    expect(s.metadata_omitted_keys).toBeUndefined();
  });
});

describe("GET /v1/delegation/runs の status フィルタとペイロード", () => {
  let env: TestAppEnv;
  beforeEach(() => { env = makeTestApp(); });

  it("status で SQL 側から絞る", async () => {
    seedRun(env, "run-run-1", "running");
    seedRun(env, "run-done-1", "completed");
    seedRun(env, "run-done-2", "completed");

    const r = await env.app.request("/v1/delegation/runs?status=running");
    const j = await r.json() as any;
    expect(j.status).toBe("running");
    expect(j.runs).toHaveLength(1);
    expect(j.runs[0].id).toBe("run-run-1");
  });

  it("空の limit は既定 100 として扱う", async () => {
    seedRun(env, "run-done-1", "completed");
    seedRun(env, "run-done-2", "completed");
    const j = await (await env.app.request("/v1/delegation/runs?limit=")).json() as any;
    expect(j.limit).toBe(100);
    expect(j.runs).toHaveLength(2);
  });

  it("未知の status は無言で全件へ倒さず 400", async () => {
    seedRun(env, "run-done-1", "completed");
    const r = await env.app.request("/v1/delegation/runs?status=bogus");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_status");
  });

  it("一覧では rendered_prompt / args_json を返さない (args は残す)", async () => {
    seedRun(env, "run-done-1", "completed");
    const j = await (await env.app.request("/v1/delegation/runs")).json() as any;
    const run = j.runs[0];
    expect(run.rendered_prompt).toBeUndefined();
    expect(run.args_json).toBeUndefined();
    expect(run.args).toEqual({ a: 1 });
  });

  it("単体取得では rendered_prompt を返す", async () => {
    seedRun(env, "run-done-1", "completed");
    const j = await (await env.app.request("/v1/delegation/runs/run-done-1")).json() as any;
    expect(j.run.rendered_prompt).toHaveLength(1_000);
  });
});
