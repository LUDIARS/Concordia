import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "./helpers/db.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { DelegationService } from "../src/delegation/service.js";
import { delegationRouter } from "../src/api/delegation.js";

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

describe("GET /v1/delegation/templates runtime options", () => {
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
    expect(claude.runtime_options).toEqual([]);
  });

  it("returns model-specific option suggestions", async () => {
    const { app } = makeApp();
    const gpt = await app.request("/v1/delegation/options?provider=codex&model=gpt-5.5");
    const gptJson = (await gpt.json()) as any;
    expect(gptJson.suggestions.map((opt: any) => opt.key)).toContain("model_reasoning_effort");
    expect(gptJson.suggestions[0].choices.map((choice: any) => choice.value)).toContain("xhigh");

    const legacy = await app.request("/v1/delegation/options?provider=codex&model=gpt-3.5-turbo");
    const legacyJson = (await legacy.json()) as any;
    expect(legacyJson.suggestions).toEqual([]);
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
