import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { makeTestApp } from "./helpers/test-app.js";
import type { SpawnRequest } from "../src/control/spawner.js";

function buildTestApp() {
  return makeTestApp();
}

describe("admin API", () => {
  let env: ReturnType<typeof buildTestApp>;
  // The single-thread Windows suite can briefly delay SQLite-backed app setup
  // beyond Vitest's 10-second default while other test resources are released.
  beforeEach(() => { env = buildTestApp(); }, 30_000);

  it("POST /v1/admin/spawn-session rejects unknown provider", async () => {
    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "ghost" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /v1/admin/spawn-session rejects a team outside the requested organization", async () => {
    const child = env.subsidiary.create({ name: "child", platform: "discord" });
    const other = env.subsidiary.create({ name: "other", platform: "discord" });
    const childTeam = env.teams.create({ name: "Child", slug: "child", subsidiary_id: child.id });

    const response = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        subsidiary_id: other.id,
        team: childTeam.id,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "team_not_owned_by_requested_organization" });
  });

  it("POST /v1/admin/spawn-session passes runtime options to delegation template spawn", async () => {
    const spawnCalls: Array<{ provider: string; args?: string[] }> = [];
    env = makeTestApp({
      delegationSpawn: (req) => {
        spawnCalls.push({ provider: req.provider, args: req.args });
        return { ok: true, pid: 123, command: ["wt.exe", req.provider, ...(req.args ?? [])] };
      },
    });
    env.delegation.createTemplate({
      call_name: "codex-runtime-options",
      title: "Codex runtime options",
      target_provider: "codex",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
    });

    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: "codex-runtime-options",
        inject_prompt: true,
        args: { task: "x" },
        options: { model_reasoning_effort: "high" },
      }),
    });

    expect(r.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      provider: "codex",
      args: ["-c", "model_reasoning_effort=\"high\""],
    });
  });

  it("POST /v1/admin/spawn-session applies Opus defaults through both direct session paths", async () => {
    const spawnCalls: SpawnRequest[] = [];
    env = makeTestApp({
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 123, command: ["wt.exe", request.provider, ...(request.args ?? [])] };
      },
    });
    env.adminState.setWorkspaceRoot(env.logsDir);
    env.delegation.createTemplate({
      call_name: "opus-direct-session",
      title: "Opus direct session",
      target_provider: "claude",
      model: "claude-opus-5",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
      default_cwd: env.logsDir,
    });

    const templateResponse = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "opus-direct-session", args: { task: "x" } }),
    });
    const directResponse = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        model: "claude-opus-5",
        cwd: env.logsDir,
        options: { thinking: true },
      }),
    });

    expect(templateResponse.status).toBe(200);
    expect(directResponse.status).toBe(200);
    expect(spawnCalls).toEqual([
      expect.objectContaining({
        provider: "claude",
        args: ["--model", "claude-opus-5", "--effort", "medium"],
        env: expect.objectContaining({ CLAUDE_CODE_DISABLE_THINKING: "1" }),
      }),
      expect.objectContaining({
        provider: "claude",
        args: ["--model", "claude-opus-5", "--effort", "medium"],
        env: expect.objectContaining({ CLAUDE_CODE_DISABLE_THINKING: "0" }),
      }),
    ]);
  });

  it("POST /v1/admin/spawn-session reports a delegation spawn failure", async () => {
    env = makeTestApp({
      delegationSpawn: () => ({ ok: false, error: "cwd does not exist: E:DocumentArsConcordia" }),
    });
    env.delegation.createTemplate({
      call_name: "failed-template-spawn",
      title: "Failed template spawn",
      target_provider: "claude",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
    });

    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: "failed-template-spawn",
        inject_prompt: true,
        args: { task: "x" },
      }),
    });

    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: "cwd does not exist: E:DocumentArsConcordia" });
  });

  it("POST /v1/admin/spawn-session falls back to workspace root for an unresolved template cwd variable", async () => {
    const spawnCalls: SpawnRequest[] = [];
    env = makeTestApp({
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 123, command: ["wt.exe", request.provider] };
      },
    });
    env.delegation.createTemplate({
      call_name: "template-needs-project",
      title: "Template needs project",
      target_provider: "codex",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
      default_cwd: "${target_repo}",
    });
    env.adminState.setWorkspaceRoot(env.logsDir);

    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "template-needs-project", args: { task: "cross-repository work" } }),
    });

    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ cwd: env.adminState.getWorkspaceRoot() });
    expect(spawnCalls).toEqual([expect.objectContaining({
      cwd: env.adminState.getWorkspaceRoot(),
    })]);
  });

  it("POST /v1/admin/spawn-session automatically selects Codex effort", async () => {
    const spawnCalls: Array<{ provider: string; args?: string[] }> = [];
    env = makeTestApp({
      delegationSpawn: (req) => {
        spawnCalls.push({ provider: req.provider, args: req.args });
        return { ok: true, pid: 123, command: ["wt.exe", req.provider, ...(req.args ?? [])] };
      },
    });
    env.delegation.createTemplate({
      call_name: "codex-default-effort",
      title: "Codex default effort",
      target_provider: "codex",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
    });

    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: "codex-default-effort",
        inject_prompt: true,
        args: { task: "x" },
      }),
    });

    expect(r.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      provider: "codex",
      args: ["-c", "model_reasoning_effort=\"low\""],
    });
  }, 30_000);

  it("POST /v1/admin/spawn-session can launch a template in a branch worktree", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "admin-wt-repo-"));
    const worktreeRoot = join(dirname(repoRoot), `${repoRoot.split(/[\\/]/).pop()}-feat-admin-wt`);
    rmSync(worktreeRoot, { recursive: true, force: true });
    initGitRepo(repoRoot);
    const spawnCalls: Array<{ provider: string; cwd?: string }> = [];
    env = makeTestApp({
      delegationSpawn: (req) => {
        spawnCalls.push({ provider: req.provider, cwd: req.cwd });
        return { ok: true, pid: 321, command: ["wt.exe", req.provider, req.cwd ?? ""] };
      },
    });
    env.delegation.createTemplate({
      call_name: "claude-branch-wt",
      title: "Claude branch WT",
      target_provider: "claude",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
      default_cwd: repoRoot,
    });

    try {
      const r = await env.app.request("/v1/admin/spawn-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template: "claude-branch-wt",
          inject_prompt: true,
          args: { task: "x" },
          branch: "feat/admin-wt",
        }),
      });

      expect(r.status).toBe(200);
      const body = (await r.json()) as { cwd: string; branch: string; worktree_created: boolean };
      expect(body.cwd).toBe(worktreeRoot);
      expect(body.branch).toBe("feat/admin-wt");
      expect(body.worktree_created).toBe(true);
      expect(spawnCalls).toEqual([{ provider: "claude", cwd: worktreeRoot }]);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  // The fixture setup launches five Git commands before the handler's own bounded
  // command sequence, so leave enough headroom for process startup under suite load.
  }, 120_000);

  it("GET /v1/admin/state exposes snapshot with defaults", async () => {
    const r = await env.app.request("/v1/admin/state");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      chat_muted: boolean;
      rules_enabled: boolean;
    };
    expect(body.chat_muted).toBe(true);
    expect(body.rules_enabled).toBe(false);
  });

  it("PUT /v1/admin/delegation-watchdog updates the unstarted threshold", async () => {
    const put = await env.app.request("/v1/admin/delegation-watchdog", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unstarted_sec: 120 }),
    });

    expect(put.status).toBe(200);
    expect((await put.json() as { unstarted_sec: number }).unstarted_sec).toBe(120);

    const get = await env.app.request("/v1/admin/delegation-watchdog");
    expect((await get.json() as { unstarted_sec: number }).unstarted_sec).toBe(120);
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

  it("GET /v1/admin/cron-jobs reports code defaults with no override applied", async () => {
    const r = await env.app.request("/v1/admin/cron-jobs");
    expect(r.status).toBe(200);
    const { jobs } = (await r.json()) as { jobs: Array<{ name: string; call_name: string; default_call_name: string }> };
    const dailyReview = jobs.find((j) => j.name === "ludiars-review-weekly");
    expect(dailyReview).toBeDefined();
    expect(dailyReview?.call_name).toBe(dailyReview?.default_call_name);
  });

  it("PUT /v1/admin/cron-jobs/:name overrides the call_name and persists it", async () => {
    env.delegation.createTemplate({
      call_name: "cron-target-active-template",
      title: "テスト用の切替先テンプレ",
      target_provider: "claude",
      prompt_template: "review ${date}",
      input_schema: [{ name: "date", type: "string", required: true }],
      is_active: true,
    });

    const put = await env.app.request("/v1/admin/cron-jobs/ludiars-review-weekly", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_name: "cron-target-active-template" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { job: { call_name: string } }).job.call_name).toBe("cron-target-active-template");

    const list = await env.app.request("/v1/admin/cron-jobs");
    const { jobs } = (await list.json()) as { jobs: Array<{ name: string; call_name: string; default_call_name: string }> };
    const dailyReview = jobs.find((j) => j.name === "ludiars-review-weekly");
    expect(dailyReview?.call_name).toBe("cron-target-active-template");
    expect(dailyReview?.default_call_name).toBe("ludiars-review-weekly");

    // schema_meta 永続化なので、同じ DB を指す新しい AdminState でも読めること。
    expect(env.adminState.getCronJobOverride("ludiars-review-weekly")).toBe("cron-target-active-template");
  });

  it("PUT /v1/admin/cron-jobs/:name rejects an unknown job", async () => {
    const r = await env.app.request("/v1/admin/cron-jobs/not-a-real-job", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_name: "ludiars-review-weekly" }),
    });
    expect(r.status).toBe(404);
  });

  it("PUT /v1/admin/cron-jobs/:name rejects an inactive call_name", async () => {
    env.delegation.createTemplate({
      call_name: "inactive-template",
      title: "inactive",
      target_provider: "claude",
      prompt_template: "x",
      input_schema: [],
      is_active: false,
    });
    const r = await env.app.request("/v1/admin/cron-jobs/ludiars-review-weekly", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_name: "inactive-template" }),
    });
    expect(r.status).toBe(400);
  });

  it("PUT /v1/admin/cron-jobs/:name with call_name: null resets to the code default", async () => {
    env.adminState.setCronJobOverride("ludiars-review-weekly", "ludiars-review-weekly");
    const r = await env.app.request("/v1/admin/cron-jobs/ludiars-review-weekly", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_name: null }),
    });
    expect(r.status).toBe(200);
    expect(env.adminState.getCronJobOverride("ludiars-review-weekly")).toBeNull();
  });

  it("GET /v1/admin/reaction-workflow reports no authorized users when the roster is empty", async () => {
    env.adminState.setReactionWorkflowEnabled(true);

    const response = await env.app.request("/v1/admin/reaction-workflow");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      readiness: {
        status: "no_authorized_users",
        authorized_user_count: 0,
        platforms: {
          discord: { authorized_user_count: 0 },
          slack: { authorized_user_count: 0 },
        },
        issues: ["discord_no_authorized_users", "slack_no_authorized_users"],
      },
    });
  });

  it("GET /v1/admin/reaction-workflow counts 管理職 from the staff roster without exposing IDs", async () => {
    env.adminState.setReactionWorkflowEnabled(true);
    // 発火自体は誰でもできるが、 件数は「権限を要する指示 (spawn / merge) を実行できる
    // 社員 = 管理職以上」なので、 ヒラ社員は人数に入らない。
    env.staff.touch({ platform: "discord", platformUserId: "discord-plain" });
    env.staff.upsertManual({ platform: "discord", platformUserId: "discord-operator", role: "manager" });
    env.staff.upsertManual({ platform: "slack", platformUserId: "slack-operator", role: "executive" });

    const response = await env.app.request("/v1/admin/reaction-workflow");
    const body = await response.json() as {
      enabled: boolean;
      readiness: {
        status: string;
        authorized_user_count: number;
        platforms: { discord: { authorized_user_count: number } };
      };
    };
    expect(body.readiness.status).toBe("ready");
    expect(body.readiness.authorized_user_count).toBe(2);
    expect(body.readiness.platforms.discord.authorized_user_count).toBe(1);
    expect(JSON.stringify(body)).not.toContain("operator");
  });

  it("PUT /v1/admin/reaction-workflow toggles the switch only", async () => {
    const response = await env.app.request("/v1/admin/reaction-workflow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { enabled: boolean }).enabled).toBe(true);
    expect(env.adminState.getReactionWorkflowEnabled()).toBe(true);
  });

  it("PUT /v1/admin/reaction-workflow rejects allowlist fields (moved to the staff roster)", async () => {
    const response = await env.app.request("/v1/admin/reaction-workflow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, discord_user_ids: ["discord-operator"] }),
    });
    expect(response.status).toBe(400);
  });

  it("PUT /v1/admin/cc-workflow toggles + GET reflects new value", async () => {
    const initial = await env.app.request("/v1/admin/cc-workflow");
    expect((await initial.json() as { enabled: boolean }).enabled).toBe(false);

    const put = await env.app.request("/v1/admin/cc-workflow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { enabled: boolean }).enabled).toBe(true);

    const get = await env.app.request("/v1/admin/cc-workflow");
    expect((await get.json() as { enabled: boolean }).enabled).toBe(true);
  });

  it("GET /v1/admin/spawn-defaults reports the configured default_cwd", async () => {
    const r = await env.app.request("/v1/admin/spawn-defaults");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { default_cwd: string; platform_supported: boolean };
    // loadConfig({}) → CONCORDIA_SPAWN_DEFAULT_CWD unset.
    // win32 + E:\Document\Ars 存在環境では auto-detect で同パスが返る (LUDIARS 運用機).
    // 他環境では fallback 無しで空文字. どちらも仕様の範囲内.
    expect(["", "E:\\Document\\Ars", "E:\\Document\\Ars\\Castra"]).toContain(body.default_cwd);
    expect(typeof body.platform_supported).toBe("boolean");
  });

  it("POST /v1/admin/stop-session/:id 404 for unknown id", async () => {
    const r = await env.app.request("/v1/admin/stop-session/nope", { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("POST /v1/admin/stop-session/:id 400 when metadata.lictor_pid missing", async () => {
    await seedSession(env, "no-meta", "DESKTOP-A", "active");
    const r = await env.app.request("/v1/admin/stop-session/no-meta", { method: "POST" });
    expect(r.status).toBe(400);
  });

  it("POST /v1/admin/stop-session/:id persists stop jobs instead of running taskkill", async () => {
    const previous = process.env.CONCORDIA_DISABLE_CLAUDE;
    process.env.CONCORDIA_DISABLE_CLAUDE = "1";
    try {
      await seedSession(env, "queued-stop", "DESKTOP-A", "active");
      env.repo.setMetadata("queued-stop", JSON.stringify({ lictor_pid: 123, agent_client_pid: 456 }));

      const r = await env.app.request("/v1/admin/stop-session/queued-stop", { method: "POST" });
      const body = await r.json() as {
        status: string;
        report_status: string;
        report_generated: boolean;
        monologue_posted: boolean;
        job_id: string;
        agent_client_job_id: string;
      };

      expect(r.status).toBe(202);
      expect(body.status).toBe("queued");
      expect(body).toMatchObject({
        report_status: "queued",
        report_generated: false,
        monologue_posted: false,
      });
      expect(env.controlJobs.findById(body.job_id)?.status).toBe("queued");
      expect(env.controlJobs.findById(body.agent_client_job_id)?.status).toBe("queued");
      await expect.poll(
        () => env.repo.findReport("queued-stop"),
        { timeout: 1_000 },
      ).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CONCORDIA_DISABLE_CLAUDE;
      else process.env.CONCORDIA_DISABLE_CLAUDE = previous;
    }
  });

  describe("/v1/admin/restart", () => {
    beforeAll(() => { process.env.CONCORDIA_RESTART_DRY_RUN = "1"; });
    afterAll(() => { delete process.env.CONCORDIA_RESTART_DRY_RUN; });

    it("dry run returns ok without spawning or exiting", async () => {
      const app = makeTestApp({ rng: () => 0.99 }).app;
      const r = await app.request("/v1/admin/restart", { method: "POST" });
      expect(r.status).toBe(200);
      const j = (await r.json()) as any;
      expect(j.ok).toBe(true);
      expect(j.dry_run).toBe(true);
    });
  });
});

async function seedSession(
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

function initGitRepo(repoRoot: string): void {
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "user.email", "concordia-test@example.invalid"]);
  git(repoRoot, ["config", "user.name", "Concordia Test"]);
  writeFileSync(join(repoRoot, "README.md"), "test\n", "utf8");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-m", "init"]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
