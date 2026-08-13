/**
 * `/v1/delegation/runs/:id/investigated` の裏取り (実 DB / in-memory)。
 *
 * 冪等性は delegation_runs の列で担保しているので、 fake ではなく実際の migration を
 * 通した DB で「2 回呼んでも実装タスクは 1 度だけ」を確認する。 Cc 再起動をまたぐ抑止も
 * 同じ列に載っているため、 これが再起動耐性の裏取りでもある。
 *
 * spec/feature/delegation-staged-injection.md §4。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { delegationRouter } from "./delegation.js";
import type { DelegationService } from "../delegation/service.js";
import { eventBus, type ConcordiaEvent } from "../events.js";

function makeApp(memoria?: { createTask: (input: { title: string }) => Promise<{ id: string | number }> }) {
  const db = makeTestDb();
  const repo = new DelegationRepo(db);
  const sessions = new SessionsRepo(db);
  const service = {} as DelegationService;
  const app = new Hono();
  app.route("/v1/delegation", delegationRouter({
    repo,
    service,
    sessions,
    concordiaUrl: "http://127.0.0.1:11111",
    memoria: memoria
      ? { createTask: memoria.createTask, taskApiUrl: (id) => `http://127.0.0.1:5180/api/tasks/${id}` }
      : undefined,
  }));
  return { app, repo, sessions };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = async (res: Response): Promise<Record<string, any>> => (await res.json()) as Record<string, any>;

function seedStagedRun(
  ctx: ReturnType<typeof makeApp>,
  opts: { runId: string; sessionId: string; wsClients?: number; staged?: boolean },
): void {
  ctx.sessions.insertSession({
    id: opts.sessionId,
    provider: "claude-code",
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: null,
    branch: "feat/staged",
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
  for (let i = 0; i < (opts.wsClients ?? 1); i++) ctx.sessions.incrementWsClients(opts.sessionId);
  ctx.repo.createRun({
    id: opts.runId,
    template_id: null,
    call_name: "claude-opus-5-impl",
    target_provider: "claude",
    parent_session_id: null,
    child_session_id: opts.sessionId,
    args: {},
    rendered_prompt: "段階注入を実装する\n- 手順 1",
    prompt_file_path: "E:/tmp/prompt.md",
    spawn_pid: 123,
    spawn_command: ["lictor", "claude"],
    triggered_by: null,
    status: "running",
    spawn_cwd: "E:/Document/Ars/Concordia",
    spawn_branch: "feat/staged",
    staged_injection: opts.staged ?? true,
  });
}

/** session.inject イベントを拾う (実際の配信経路と同じ eventBus)。 */
function captureInjects(): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  const stop = eventBus.subscribe((event: ConcordiaEvent) => {
    if (event.type === "session.inject") texts.push(event.text);
  });
  return { texts, stop: () => stop() };
}

describe("/v1/delegation/runs/:id/investigated", () => {
  let ctx: ReturnType<typeof makeApp>;
  let injects: ReturnType<typeof captureInjects>;

  beforeEach(() => { injects = captureInjects(); });

  it("調査報告を受けて実装タスク (why/task/Memoria/完了条件) を 1 通配信する", async () => {
    const createTask = vi.fn(async () => ({ id: 42 }));
    ctx = makeApp({ createTask });
    seedStagedRun(ctx, { runId: "run-a", sessionId: "sess-a" });

    const res = await post(ctx.app, "/v1/delegation/runs/run-a/investigated", {
      summary: "現行の初回 inject が承認待ちを要求している",
      files: ["src/delegation/persona-context.ts"],
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ ok: true, delivered: true, already_delivered: false, memoria_task_id: "42" });

    expect(injects.texts).toHaveLength(1);
    expect(injects.texts[0]).toContain("### なぜ (why)");
    expect(injects.texts[0]).toContain("段階注入を実装する");
    expect(injects.texts[0]).toContain("http://127.0.0.1:5180/api/tasks/42");
    expect(injects.texts[0]).toContain("### 完了条件");

    const run = ctx.repo.findRun("run-a")!;
    expect(run.staged_followup_at).not.toBeNull();
    expect(run.memoria_task_id).toBe("42");
    expect(run.investigation_summary).toContain("承認待ちを要求している");
    injects.stop();
  });

  it("同じ報告を 2 回投げても実装タスクは 1 度しか届かない (再送に冪等)", async () => {
    const createTask = vi.fn(async () => ({ id: 7 }));
    ctx = makeApp({ createTask });
    seedStagedRun(ctx, { runId: "run-b", sessionId: "sess-b" });

    await post(ctx.app, "/v1/delegation/runs/run-b/investigated", { summary: "調査済み" });
    const second = await post(ctx.app, "/v1/delegation/runs/run-b/investigated", { summary: "調査済み" });
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({ ok: true, delivered: false, already_delivered: true });
    expect(injects.texts).toHaveLength(1);
    expect(createTask).toHaveBeenCalledTimes(1);
    injects.stop();
  });

  it("段階注入で起動していない run は 409 run_not_staged", async () => {
    ctx = makeApp();
    seedStagedRun(ctx, { runId: "run-c", sessionId: "sess-c", staged: false });
    const res = await post(ctx.app, "/v1/delegation/runs/run-c/investigated", { summary: "調査済み" });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("run_not_staged");
    expect(injects.texts).toHaveLength(0);
    injects.stop();
  });

  it("子セッション未接続なら成功扱いにせず 409 (inject が静かに消えるため)", async () => {
    ctx = makeApp();
    seedStagedRun(ctx, { runId: "run-d", sessionId: "sess-d", wsClients: 0 });
    const res = await post(ctx.app, "/v1/delegation/runs/run-d/investigated", { summary: "調査済み" });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("child_session_not_connected");
    const run = ctx.repo.findRun("run-d")!;
    expect(run.staged_followup_at ?? null).toBeNull();
    injects.stop();
  });

  it("summary が無い body は 400 (調査していない報告を通さない)", async () => {
    ctx = makeApp();
    seedStagedRun(ctx, { runId: "run-e", sessionId: "sess-e" });
    const res = await post(ctx.app, "/v1/delegation/runs/run-e/investigated", { files: ["a.ts"] });
    expect(res.status).toBe(400);
    injects.stop();
  });

  it("存在しない run は 404", async () => {
    ctx = makeApp();
    const res = await post(ctx.app, "/v1/delegation/runs/missing/investigated", { summary: "x" });
    expect(res.status).toBe(404);
    injects.stop();
  });

  it("Memoria が落ちていても実装タスクは届き、未作成の理由が本文に載る", async () => {
    ctx = makeApp({ createTask: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }) });
    seedStagedRun(ctx, { runId: "run-f", sessionId: "sess-f" });
    const res = await post(ctx.app, "/v1/delegation/runs/run-f/investigated", { summary: "調査済み" });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ ok: true, delivered: true, memoria_task_id: null });
    expect(body.memoria_error).toContain("ECONNREFUSED");
    expect(injects.texts[0]).toContain("未作成");
    injects.stop();
  });
});
