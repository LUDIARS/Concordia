import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationService } from "../delegation/service.js";
import type { TaskMdStore } from "../taskflow/md-store.js";
import { seedSessionContract } from "../contract/seed-rules.js";
import type { SessionRow } from "../shared/types.js";
import { delegationRouter } from "./delegation.js";

describe("delegation partial status", () => {
  it("requeues once without advancing taskflow and notifies the parent", async () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const sessions = new SessionsRepo(db);
    sessions.insertSession({
      id: "parent-session",
      provider: "codex-cli",
      repo_path: "E:/repo",
      repo_origin: "LUDIARS/Concordia",
      branch: "feat/partial",
      host: "test-host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    });
    repo.createRun({
      id: "source-run",
      template_id: null,
      call_name: "impl",
      target_provider: "codex",
      parent_session_id: "parent-session",
      args: { task: "finish" },
      rendered_prompt: "prompt",
      prompt_file_path: "E:/tmp/prompt.md",
      spawn_pid: 1,
      spawn_command: ["codex"],
      triggered_by: null,
      status: "running",
      spawn_cwd: "E:/repo",
      spawn_branch: "feat/partial",
      team_id: "team-a",
      effective_model: "gpt-5.6-sol",
      effort_level: "high",
      fast_mode: true,
    });

    const invoke = vi.fn(async (input: Parameters<DelegationService["invoke"]>[0]) => {
      const run = repo.createRun({
        id: "residual-run",
        template_id: null,
        call_name: "impl",
        target_provider: "codex",
        parent_session_id: "parent-session",
        args: { task: "finish" },
        rendered_prompt: "residual",
        prompt_file_path: "E:/tmp/residual.md",
        spawn_pid: 2,
        spawn_command: ["codex"],
        triggered_by: "partial-requeue:source-run",
        status: "spawned",
        team_id: typeof input.options?.team === "string" ? input.options.team : null,
      });
      return { ok: true as const, run } as Awaited<ReturnType<DelegationService["invoke"]>>;
    });
    const recordEffortOutcome = vi.fn();
    const service = { invoke, recordEffortOutcome } as unknown as DelegationService;
    const onTaskflowCompleted = vi.fn(async () => undefined);
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo,
      sessions,
      service,
      onTaskflowCompleted,
    }));
    const body = {
      status: "partial",
      remaining: [{ title: "finish API", scope_dirs: ["src/api"] }],
    };

    const first = await postStatus(app, body);
    expect(first.status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      options: { team: "team-a", fast_mode: true },
      overrides: { provider: "codex", model: "gpt-5.6-sol", reasoning_effort: "high" },
    }));
    expect(repo.findRun("residual-run")?.team_id).toBe("team-a");
    expect(onTaskflowCompleted).not.toHaveBeenCalled();
    expect(recordEffortOutcome).not.toHaveBeenCalled();
    expect(repo.findRun("source-run")?.status).toBe("completed");
    expect(sessions.eventsByKind("parent-session", "inject")).toHaveLength(1);
    expect(sessions.eventsByKind("parent-session", "inject")[0]?.payload).toContain("Delegation partial");

    const duplicate = await postStatus(app, body);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true, requeued_run: null });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sessions.eventsByKind("parent-session", "inject")).toHaveLength(1);
  });

  it("atomically rejects a concurrent partial requeue", async () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    repo.createRun({
      id: "source-run",
      template_id: null,
      call_name: "impl",
      target_provider: "codex",
      parent_session_id: null,
      args: { task: "finish" },
      rendered_prompt: "prompt",
      prompt_file_path: "E:/tmp/prompt.md",
      spawn_pid: 1,
      spawn_command: ["codex"],
      triggered_by: null,
      status: "running",
    });
    let releaseInvoke!: () => void;
    const invokeGate = new Promise<void>((resolve) => { releaseInvoke = resolve; });
    const invoke = vi.fn(async () => {
      await invokeGate;
      const run = repo.createRun({
        id: "residual-run",
        template_id: null,
        call_name: "impl",
        target_provider: "codex",
        parent_session_id: null,
        args: { task: "finish" },
        rendered_prompt: "residual",
        prompt_file_path: "E:/tmp/residual.md",
        spawn_pid: 2,
        spawn_command: ["codex"],
        triggered_by: "partial-requeue:source-run",
        status: "spawned",
      });
      return { ok: true as const, run } as Awaited<ReturnType<DelegationService["invoke"]>>;
    });
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo,
      service: { invoke, recordEffortOutcome: vi.fn() } as unknown as DelegationService,
    }));
    const body = { status: "partial", remaining: [{ title: "finish API" }] };

    const first = postStatus(app, body);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(repo.listSlotOccupyingRuns()).toEqual([
      expect.objectContaining({ id: "source-run", status: "blocked" }),
    ]);
    const concurrent = await postStatus(app, body);
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({ error: "partial_requeue_in_progress" });
    expect(invoke).toHaveBeenCalledTimes(1);

    releaseInvoke();
    expect((await first).status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe("completed");
    expect(repo.findRunByTriggeredBy("partial-requeue:source-run")?.id).toBe("residual-run");
  });

  it("continues in the child session when the typed contract requests it", async () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const sessions = new SessionsRepo(db);
    const child = {
      id: "child-session",
      provider: "codex-cli",
      repo_path: "E:/repo",
      repo_origin: "LUDIARS/Concordia",
      branch: "feat/partial",
      host: "test-host",
      started_at: 1,
      ended_at: null,
      status: "active",
      last_seen_at: 1,
      current_task: "finish",
      transcript_path: null,
      metadata: null,
      ws_clients: 0,
      target_project: "Concordia",
    } as SessionRow;
    const contract = seedSessionContract(child, "small fix", "discord:1");
    contract.continuation = {
      value: "in-session",
      decided_by: "human",
      rationale: "keep interactive context",
      genius_card_ids: [],
    };
    sessions.insertSession({
      id: child.id,
      provider: child.provider,
      repo_path: child.repo_path,
      repo_origin: child.repo_origin,
      branch: child.branch,
      host: child.host,
      started_at: child.started_at,
      last_seen_at: child.last_seen_at,
      transcript_path: child.transcript_path,
      metadata: JSON.stringify({ contract }),
      target_project: child.target_project,
    });
    repo.createRun({
      id: "source-run",
      template_id: null,
      call_name: "impl",
      target_provider: "codex",
      parent_session_id: null,
      child_session_id: child.id,
      args: { task: "finish" },
      rendered_prompt: "prompt",
      prompt_file_path: "E:/tmp/prompt.md",
      spawn_pid: 1,
      spawn_command: ["codex"],
      triggered_by: null,
      status: "running",
    });
    const invoke = vi.fn();
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo,
      sessions,
      service: { invoke, recordEffortOutcome: vi.fn() } as unknown as DelegationService,
    }));

    const response = await postStatus(app, {
      status: "partial",
      remaining: [{ title: "finish API" }],
    });

    expect(response.status).toBe(200);
    expect(invoke).not.toHaveBeenCalled();
    expect(repo.findRun("source-run")?.status).toBe("running");
    expect(sessions.eventsByKind(child.id, "inject")).toHaveLength(1);
  });

  it("fails instead of requeueing when the partial-requeue depth reaches the limit", async () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    for (const [id, triggeredBy] of [["root-run", null], ["parent-run", "partial-requeue:root-run"], ["source-run", "partial-requeue:parent-run"]] as const) {
      repo.createRun({
        id,
        template_id: null,
        call_name: "impl",
        target_provider: "codex",
        parent_session_id: null,
        args: { task: "finish" },
        rendered_prompt: "prompt",
        prompt_file_path: "E:/tmp/prompt.md",
        spawn_pid: 1,
        spawn_command: ["codex"],
        triggered_by: triggeredBy,
        status: "running",
      });
    }
    const invoke = vi.fn();
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo,
      service: { invoke, recordEffortOutcome: vi.fn() } as unknown as DelegationService,
    }));

    expect((await postStatus(app, {
      status: "partial",
      remaining: [{ title: "Revisor merge wait", kind: "work" }],
    })).status).toBe(200);
    expect(repo.findRun("source-run")).toMatchObject({
      status: "failed",
      error: "partial_requeue_limit: depth=2 remaining=Revisor merge wait",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fails instead of requeueing when every remaining task already exists", async () => {
    const db = makeTestDb();
    const repo = createSourceRun(repoFor(db));
    const invoke = vi.fn();
    const taskStore = {
      writeRemainingTasks: vi.fn(async () => ({ created: [], existed: ["E:/repo/spec/tasks/already-exists.md"] })),
    } as unknown as TaskMdStore;
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo,
      taskStore,
      service: { invoke, recordEffortOutcome: vi.fn() } as unknown as DelegationService,
    }));

    expect((await postStatus(app, { status: "partial", remaining: [{ title: "finish API" }] })).status).toBe(200);
    expect(repo.findRun("source-run")).toMatchObject({ status: "failed", error: "partial_no_progress" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("completes a partial report containing only explicit or inferred wait work", async () => {
    const db = makeTestDb();
    const repo = createSourceRun(repoFor(db));
    const invoke = vi.fn();
    const writeRemainingTasks = vi.fn();
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo,
      taskStore: { writeRemainingTasks } as unknown as TaskMdStore,
      service: { invoke, recordEffortOutcome: vi.fn() } as unknown as DelegationService,
    }));

    expect((await postStatus(app, {
      status: "partial",
      remaining: [
        { title: "external approval", kind: "wait" },
        { title: "Revisor review", note: "pending" },
      ],
    })).status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe("completed");
    expect(writeRemainingTasks).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requeues when at least one remaining task was newly written", async () => {
    const db = makeTestDb();
    const repo = createSourceRun(repoFor(db));
    const invoke = vi.fn(async () => ({ ok: true as const, run: repo.createRun({
      id: "residual-run", template_id: null, call_name: "impl", target_provider: "codex", parent_session_id: null,
      args: { task: "finish" }, rendered_prompt: "residual", prompt_file_path: "E:/tmp/residual.md", spawn_pid: 2,
      spawn_command: ["codex"], triggered_by: "partial-requeue:source-run", status: "spawned",
    }) }));
    const writeRemainingTasks = vi.fn(async () => ({ created: ["E:/repo/spec/tasks/new.md"], existed: ["E:/repo/spec/tasks/old.md"] }));
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo,
      taskStore: { writeRemainingTasks } as unknown as TaskMdStore,
      service: { invoke, recordEffortOutcome: vi.fn() } as unknown as DelegationService,
    }));

    expect((await postStatus(app, { status: "partial", remaining: [{ title: "finish API" }] })).status).toBe(200);
    expect(writeRemainingTasks).toHaveBeenCalledWith(expect.objectContaining({ sourceRunId: "source-run" }));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

function repoFor(db: ReturnType<typeof makeTestDb>): DelegationRepo {
  return new DelegationRepo(db);
}

function createSourceRun(repo: DelegationRepo): DelegationRepo {
  repo.createRun({
    id: "source-run", template_id: null, call_name: "impl", target_provider: "codex", parent_session_id: null,
    args: { task: "finish" }, rendered_prompt: "prompt", prompt_file_path: "E:/tmp/prompt.md", spawn_pid: 1,
    spawn_command: ["codex"], triggered_by: null, status: "running", spawn_cwd: "E:/repo",
  });
  return repo;
}

function postStatus(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(app.request("/v1/delegation/runs/source-run/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}
