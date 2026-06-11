import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function buildTestApp() {
  return makeTestApp();
}

describe("machines API + admin spawn/stop", () => {
  let env: ReturnType<typeof buildTestApp>;
  beforeEach(() => { env = buildTestApp(); });

  it("GET /v1/machines aggregates sessions per host with per-status counts", async () => {
    await seed(env, "s1", "DESKTOP-A", "active");
    await seed(env, "s2", "DESKTOP-A", "active");
    await seed(env, "s3", "DESKTOP-A", "ended");
    await seed(env, "s4", "DESKTOP-B", "active");

    const r = await env.app.request("/v1/machines");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { machines: Array<{ host: string; active: number; ended: number }> };
    const byHost = Object.fromEntries(j.machines.map((m) => [m.host, m]));
    expect(byHost["DESKTOP-A"]).toMatchObject({ active: 2, ended: 1 });
    expect(byHost["DESKTOP-B"]).toMatchObject({ active: 1, ended: 0 });
  });

  it("GET /v1/machines/:host returns sessions filtered by host", async () => {
    await seed(env, "s1", "DESKTOP-A", "active");
    await seed(env, "s2", "DESKTOP-B", "active");

    const r = await env.app.request("/v1/machines/DESKTOP-A");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { host: string; sessions: Array<{ id: string }> };
    expect(j.host).toBe("DESKTOP-A");
    expect(j.sessions.map((s) => s.id).sort()).toEqual(["s1"]);
  });

  it("POST /v1/admin/spawn-session rejects unknown provider", async () => {
    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "ghost" }),
    });
    expect(r.status).toBe(400);
  });

  it("GET /v1/admin/state exposes snapshot triple with defaults", async () => {
    const r = await env.app.request("/v1/admin/state");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      chat_muted: boolean;
      rules_enabled: boolean;
      rule_proposer_interval_sec: number;
    };
    expect(body.chat_muted).toBe(true);
    expect(body.rules_enabled).toBe(false);
    expect(body.rule_proposer_interval_sec).toBe(3600);
  });

  it("PUT /v1/admin/chat-mute toggles + GET reflects new value", async () => {
    const put = await env.app.request("/v1/admin/chat-mute", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted: false }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { muted: boolean }).muted).toBe(false);

    const get = await env.app.request("/v1/admin/chat-mute");
    expect((await get.json() as { muted: boolean }).muted).toBe(false);
  });

  it("PUT /v1/admin/chat-mute rejects non-boolean", async () => {
    const r = await env.app.request("/v1/admin/chat-mute", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted: "yes" }),
    });
    expect(r.status).toBe(400);
  });

  it("PUT /v1/admin/rules-enabled toggles + persists", async () => {
    const put = await env.app.request("/v1/admin/rules-enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { enabled: boolean }).enabled).toBe(true);
  });

  it("PUT /v1/admin/rule-proposer-interval clamps + GET echoes", async () => {
    const tooSmall = await env.app.request("/v1/admin/rule-proposer-interval", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interval_sec: 10 }),
    });
    expect(tooSmall.status).toBe(200);
    const body = await tooSmall.json() as { interval_sec: number };
    expect(body.interval_sec).toBe(60); // clamped to MIN
  });

  it("PUT /v1/admin/rule-proposer-interval rejects non-number", async () => {
    const r = await env.app.request("/v1/admin/rule-proposer-interval", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interval_sec: "abc" }),
    });
    expect(r.status).toBe(400);
  });

  it("GET /v1/admin/spawn-defaults reports the configured default_cwd", async () => {
    const r = await env.app.request("/v1/admin/spawn-defaults");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { default_cwd: string; platform_supported: boolean };
    // loadConfig({}) → CONCORDIA_SPAWN_DEFAULT_CWD unset.
    // win32 + E:\Document\Ars 存在環境では auto-detect で同パスが返る (LUDIARS 運用機).
    // 他環境では fallback 無しで空文字. どちらも仕様の範囲内.
    expect(["", "E:\\Document\\Ars"]).toContain(body.default_cwd);
    expect(typeof body.platform_supported).toBe("boolean");
  });

  it("POST /v1/admin/stop-session/:id 404 for unknown id", async () => {
    const r = await env.app.request("/v1/admin/stop-session/nope", { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("POST /v1/admin/stop-session/:id 400 when metadata.lictor_pid missing", async () => {
    await seed(env, "no-meta", "DESKTOP-A", "active");
    const r = await env.app.request("/v1/admin/stop-session/no-meta", { method: "POST" });
    expect(r.status).toBe(400);
  });
});

async function seed(
  env: ReturnType<typeof buildTestApp>,
  id: string,
  host: string,
  status: "active" | "ended" | "lost" | "abandoned",
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  env.repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "/repo",
    repo_origin: null,
    branch: null,
    host,
    started_at: now,
    last_seen_at: now,
    transcript_path: null,
    metadata: null,
  });
  if (status !== "active") env.repo.setStatus(id, status, now, now);
}
