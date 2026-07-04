import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { makeTestApp } from "./helpers/test-app.js";

function buildTestApp() {
  return makeTestApp();
}

describe("admin API", () => {
  let env: ReturnType<typeof buildTestApp>;
  beforeEach(() => { env = buildTestApp(); });

  it("POST /v1/admin/spawn-session rejects unknown provider", async () => {
    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "ghost" }),
    });
    expect(r.status).toBe(400);
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
      args: ["-c", 'model_reasoning_effort="high"'],
    });
  });

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
  }, 15_000);

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
    await seedSession(env, "no-meta", "DESKTOP-A", "active");
    const r = await env.app.request("/v1/admin/stop-session/no-meta", { method: "POST" });
    expect(r.status).toBe(400);
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
