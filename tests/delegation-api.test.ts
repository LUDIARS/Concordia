import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "./helpers/db.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { DelegationService } from "../src/delegation/service.js";
import { delegationRouter } from "../src/api/delegation.js";
import { eventBus, type ConcordiaEvent } from "../src/events.js";
import { makeTestApp } from "./helpers/test-app.js";

function makeApp() {
  const db = makeTestDb();
  const repo = new DelegationRepo(db);
  const sessions = new SessionsRepo(db);
  const service = new DelegationService({ repo, spawn: () => ({ ok: true, pid: 1, command: [] }) });
  const app = new Hono();
  app.route("/v1/delegation", delegationRouter({ repo, service, sessions }));
  return { app, repo, sessions };
}

async function postTemplate(app: Hono, body: unknown) {
  return app.request("/v1/delegation/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/delegation/templates (空欄許容)", () => {
  let app: Hono;
  beforeEach(() => { app = makeApp().app; });

  it("call_name / title / prompt_template すべて空でも 201、 call_name を自動採番", async () => {
    const r = await postTemplate(app, { target_provider: "codex" });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.template.call_name).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(j.template.prompt_template).toBe("");
    // title 空は call_name で代替
    expect(j.template.title).toBe(j.template.call_name);
  });

  it("title からスラッグ化して call_name を作る", async () => {
    const r = await postTemplate(app, { target_provider: "codex", title: "Build The Thing" });
    const j = (await r.json()) as any;
    expect(j.template.call_name).toBe("build-the-thing");
  });

  it("call_name 衝突時は連番でユニーク化する", async () => {
    await postTemplate(app, { target_provider: "codex", call_name: "dup", title: "x" });
    const r = await postTemplate(app, { target_provider: "codex", call_name: "dup", title: "y" });
    const j = (await r.json()) as any;
    expect(j.template.call_name).toBe("dup-2");
  });

  it("日本語 title だけのときはランダム tpl- 採番", async () => {
    const r = await postTemplate(app, { target_provider: "codex", title: "実装委託" });
    const j = (await r.json()) as any;
    expect(j.template.call_name).toMatch(/^tpl-[0-9a-f]{8}$/);
  });
});

describe("delegation category (雇用形態カテゴリ)", () => {
  let app: Hono;
  beforeEach(() => { app = makeApp().app; });

  it("create は category を受理し、 省略時は employee になる", async () => {
    const withCat = await postTemplate(app, { target_provider: "claude", call_name: "pt", category: "parttimer" });
    expect(withCat.status).toBe(201);
    expect(((await withCat.json()) as any).template.category).toBe("parttimer");

    const noCat = await postTemplate(app, { target_provider: "codex", call_name: "emp" });
    expect(((await noCat.json()) as any).template.category).toBe("employee");
  });

  it("create は不正な category を 400 で拒否する", async () => {
    const r = await postTemplate(app, { target_provider: "codex", call_name: "bad", category: "intern" });
    expect(r.status).toBe(400);
  });

  it("PATCH で category を変更できる", async () => {
    const created = (await (await postTemplate(app, { target_provider: "codex", call_name: "mv" })).json()) as any;
    const r = await app.request(`/v1/delegation/templates/${created.template.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "freelancer" }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).template.category).toBe("freelancer");
  });

  it("GET /templates?category= で絞り込み、 不正値は 400", async () => {
    await postTemplate(app, { target_provider: "codex", call_name: "a-emp" });
    await postTemplate(app, { target_provider: "claude", call_name: "b-pt", category: "parttimer" });

    const filtered = await app.request("/v1/delegation/templates?category=parttimer");
    expect(filtered.status).toBe(200);
    const j = (await filtered.json()) as any;
    expect(j.templates.map((t: any) => t.call_name)).toEqual(["b-pt"]);

    const all = (await (await app.request("/v1/delegation/templates")).json()) as any;
    expect(all.templates.length).toBe(2);

    const bad = await app.request("/v1/delegation/templates?category=intern");
    expect(bad.status).toBe(400);
  });
});

describe("GET /v1/delegation/templates runtime options", () => {
  it("orders templates by sort_order and allows patching order", async () => {
    const { app } = makeApp();
    await postTemplate(app, { target_provider: "codex", call_name: "b", title: "B", sort_order: 20 });
    const a = await postTemplate(app, { target_provider: "codex", call_name: "a", title: "A", sort_order: 30 });
    const aJson = (await a.json()) as any;

    let r = await app.request("/v1/delegation/templates");
    let j = (await r.json()) as any;
    expect(j.templates.map((t: any) => t.call_name)).toEqual(["b", "a"]);
    expect(j.templates.find((t: any) => t.call_name === "a").sort_order).toBe(30);

    const patch = await app.request(`/v1/delegation/templates/${aJson.template.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sort_order: 10 }),
    });
    expect(patch.status).toBe(200);
    r = await app.request("/v1/delegation/templates");
    j = (await r.json()) as any;
    expect(j.templates.map((t: any) => t.call_name)).toEqual(["a", "b"]);
  });

  it("returns provider-specific runtime option suggestions", async () => {
    const { app } = makeApp();
    await postTemplate(app, {
      target_provider: "codex",
      call_name: "codex-job",
      title: "Codex Job",
      model: "gpt-5.5",
      runtime_options: { model_reasoning_effort: "high" },
    });
    await postTemplate(app, { target_provider: "claude", call_name: "claude-job", title: "Claude Job" });
    const r = await app.request("/v1/delegation/templates");
    const j = (await r.json()) as any;
    const codex = j.templates.find((t: any) => t.call_name === "codex-job");
    const claude = j.templates.find((t: any) => t.call_name === "claude-job");
    expect(codex.runtime_options.map((opt: any) => opt.key)).toContain("model_reasoning_effort");
    expect(codex.default_options).toEqual({ model_reasoning_effort: "high" });
    expect(claude.runtime_options.map((opt: any) => opt.key)).toEqual(["thinking", "effort", "fast_mode", "goal_and_go"]);
  });

  it("returns model-specific option suggestions", async () => {
    const { app } = makeApp();
    const gpt = await app.request("/v1/delegation/options?provider=codex&model=gpt-5.5");
    const gptJson = (await gpt.json()) as any;
    expect(gptJson.suggestions.map((opt: any) => opt.key)).toContain("model_reasoning_effort");
    expect(gptJson.suggestions[0].choices.map((choice: any) => choice.value)).toContain("xhigh");

    const legacy = await app.request("/v1/delegation/options?provider=codex&model=gpt-3.5-turbo");
    const legacyJson = (await legacy.json()) as any;
    expect(legacyJson.suggestions.map((opt: any) => opt.key)).toEqual(["goal_and_go"]);
  });
});

describe("GET /v1/delegation/runs linked sessions", () => {
  it("links sessions by delegation_run_id metadata", async () => {
    const { app, repo, sessions } = makeApp();
    const run = repo.createRun({
      template_id: null,
      call_name: "impl-from-design",
      target_provider: "codex",
      args: {},
      rendered_prompt: "prompt",
      prompt_file_path: "prompt.md",
      spawn_pid: 10,
      spawn_command: [],
      triggered_by: "test",
      status: "spawned",
    });
    sessions.insertSession({
      id: "sess-exact",
      provider: "codex-cli",
      repo_path: "C:/work/exact",
      repo_origin: null,
      branch: "branch/exact",
      host: "host",
      started_at: Math.floor(run.created_at / 1000) + 3600,
      last_seen_at: Math.floor(run.created_at / 1000) + 3600,
      transcript_path: null,
      metadata: JSON.stringify({ delegation_run_id: run.id }),
    });

    const r = await app.request("/v1/delegation/runs?limit=10");
    const j = (await r.json()) as any;
    const got = j.runs.find((x: any) => x.id === run.id);
    expect(got.sessions.map((s: any) => s.id)).toEqual(["sess-exact"]);
  });

  it("links legacy sessions by target repo, call_name, and start time", async () => {
    const { app, repo, sessions } = makeApp();
    const run = repo.createRun({
      template_id: null,
      call_name: "impl-from-design",
      target_provider: "codex",
      args: { target_repo: "C:\\work\\legacy" },
      rendered_prompt: "prompt",
      prompt_file_path: "prompt.md",
      spawn_pid: 11,
      spawn_command: [],
      triggered_by: "test",
      status: "spawned",
    });
    const startedAt = Math.floor(run.created_at / 1000);
    sessions.insertSession({
      id: "sess-legacy",
      provider: "codex-cli",
      repo_path: "C:/work/legacy",
      repo_origin: null,
      branch: "branch/legacy",
      host: "host",
      started_at: startedAt,
      last_seen_at: startedAt,
      transcript_path: null,
      metadata: JSON.stringify({ delegation_call_name: "impl-from-design" }),
    });

    const r = await app.request("/v1/delegation/runs?limit=10");
    const j = (await r.json()) as any;
    const got = j.runs.find((x: any) => x.id === run.id);
    expect(got.sessions.map((s: any) => s.id)).toEqual(["sess-legacy"]);
  });
});

describe("delegation coordination API", () => {
  it("GET /runs filters by parent_session", async () => {
    const { app, repo } = makeApp();
    const common = {
      template_id: null,
      call_name: "impl-from-design",
      target_provider: "codex" as const,
      args: {},
      rendered_prompt: "prompt",
      prompt_file_path: "prompt.md",
      spawn_pid: null,
      spawn_command: null,
      triggered_by: "test",
      status: "spawned" as const,
    };
    const runA = repo.createRun({ ...common, parent_session_id: "parent-a" });
    repo.createRun({ ...common, parent_session_id: "parent-b" });

    const r = await app.request("/v1/delegation/runs?parent_session=parent-a");
    const j = (await r.json()) as any;
    expect(j.runs.map((run: any) => run.id)).toEqual([runA.id]);
    expect(j.runs[0].parent_session_id).toBe("parent-a");
  });

  it("POST /runs/:id/status updates run and injects terminal status into parent", async () => {
    const { app, repo, sessions } = makeApp();
    sessions.insertSession({
      id: "parent-1",
      provider: "codex-cli",
      repo_path: "C:/work/parent",
      repo_origin: null,
      branch: null,
      host: "host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    });
    const run = repo.createRun({
      template_id: null,
      call_name: "impl-from-design",
      target_provider: "codex",
      parent_session_id: "parent-1",
      child_session_id: "child-1",
      args: {},
      rendered_prompt: "prompt",
      prompt_file_path: "prompt.md",
      spawn_pid: null,
      spawn_command: null,
      triggered_by: "test",
      status: "running",
    });
    const events: ConcordiaEvent[] = [];
    const unsub = eventBus.subscribe((ev) => {
      if (
        ev.type === "session.inject"
        || ev.type === "delegation.mirror"
        || ev.type === "delegation.run_changed"
      ) events.push(ev);
    });
    try {
      const r = await app.request(`/v1/delegation/runs/${run.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed", detail: "done", result: "PR ready" }),
      });
      expect(r.status).toBe(200);
      expect(repo.findRun(run.id)?.status).toBe("completed");
      expect(events.some((ev) => ev.type === "session.inject" && ev.target_session_id === "parent-1")).toBe(true);
      expect(events.some((ev) => ev.type === "delegation.mirror" && ev.target_session_id === "parent-1")).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: "delegation.run_changed",
        parent_session_id: "parent-1",
        run_id: run.id,
        status: "completed",
      }));
      expect(sessions.recentEvents("parent-1", 1)[0].kind).toBe("inject");
    } finally {
      unsub();
    }
  });

  it("POST /runs/:id/inject emits child inject and mirrors to parent", async () => {
    const { app, repo, sessions } = makeApp();
    sessions.insertSession({
      id: "child-1",
      provider: "codex-cli",
      repo_path: "C:/work/child",
      repo_origin: null,
      branch: null,
      host: "host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    });
    // /runs/:id/inject は接続済み (ws_clients>0) の session にしか成功応答を返さない
    // (継続レビュー指摘: 未接続だと session.inject が届く相手がおらず静かに消える)。
    sessions.incrementWsClients("child-1");
    const run = repo.createRun({
      template_id: null,
      call_name: "impl-from-design",
      target_provider: "codex",
      parent_session_id: "parent-1",
      child_session_id: "child-1",
      args: {},
      rendered_prompt: "prompt",
      prompt_file_path: "prompt.md",
      spawn_pid: null,
      spawn_command: null,
      triggered_by: "test",
      status: "running",
    });
    const events: ConcordiaEvent[] = [];
    const unsub = eventBus.subscribe((ev) => {
      if (ev.type === "session.inject" || ev.type === "delegation.mirror") events.push(ev);
    });
    try {
      const r = await app.request(`/v1/delegation/runs/${run.id}/inject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "please continue" }),
      });
      expect(r.status).toBe(200);
      expect(events.some((ev) => ev.type === "session.inject" && ev.target_session_id === "child-1")).toBe(true);
      expect(events.some((ev) => ev.type === "delegation.mirror" && ev.target_session_id === "parent-1")).toBe(true);
      expect(sessions.recentEvents("child-1", 1)[0].kind).toBe("inject");
    } finally {
      unsub();
    }
  });

  it("session register claims delegation_run_id as child_session_id", async () => {
    const env = makeTestApp();
    const run = env.delegation.createRun({
      template_id: null,
      call_name: "impl-from-design",
      target_provider: "codex",
      parent_session_id: "parent-1",
      args: {},
      rendered_prompt: "prompt",
      prompt_file_path: "prompt.md",
      spawn_pid: null,
      spawn_command: null,
      triggered_by: "test",
      status: "spawned",
    });
    const events: ConcordiaEvent[] = [];
    const unsub = eventBus.subscribe((event) => {
      if (event.type === "delegation.run_changed") events.push(event);
    });
    try {
      const r = await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "child-1",
          provider: "codex-cli",
          repo_path: "C:/work/child",
          host: "host",
          metadata: { delegation_run_id: run.id },
        }),
      });
      expect(r.status).toBe(200);
      expect(env.delegation.findRun(run.id)).toMatchObject({
        child_session_id: "child-1",
        status: "running",
      });
      const meta = JSON.parse(env.repo.findSession("child-1")!.metadata!);
      expect(meta.delegation_parent_session_id).toBe("parent-1");
      expect(meta.delegation_call_name).toBe("impl-from-design");
      expect(events).toContainEqual(expect.objectContaining({
        type: "delegation.run_changed",
        parent_session_id: "parent-1",
        run_id: run.id,
        status: "running",
      }));
    } finally {
      unsub();
    }
  });
});
