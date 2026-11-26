import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { TaskDocument } from "../taskflow/types.js";
import { DESK_LAUNCH_CONFIRM_WINDOW_MS } from "./desk-request-policy.js";
import type { DeskDelegationRun } from "./project-control-delegation.js";
import { DeskRepository } from "./repository.js";
import { DeskRoutingDispatcher, type DeskRoutingPorts } from "./routing-dispatcher.js";
import { canOfferDeskRequest, currentProjectControl, resolveDeskProject, type ProjectControlSession } from "./routing-policy.js";
import { DeskService } from "./service.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:4cbdfaf5 */
import augurContract_a3b2cc89 from './routing-capacity-test.contract.js'; /* augur-inject:contract-predicate:fe68a44a */

const project = { code: "Cc", name: "Concordia", repoPath: "/repos/Concordia" };
const otherProject = { code: "At", name: "Actio", repoPath: "/repos/Actio" };

function setup(options: { launch?: DeskRoutingPorts["launch"] } = {}) {
  let time = 1;
  let sequence = 0;
  const tasks = new Map<string, TaskDocument>();
  const runs = new Map<string, DeskDelegationRun>();
  const controllers = new Set<string>();
  const sessions: ProjectControlSession[] = [];
  const now = () => time;
  const id = () => String(++sequence);
  const repo = new DeskRepository(makeTestDb());
  const projects = () => [project, otherProject];
  const projectControl = (target: typeof project) => currentProjectControl(sessions, repo.projectLaunch(target.code)?.spawn_id ?? null);
  const service = new DeskService(repo, { now, id, isEnabled: () => true, projects,
    canClaim: (sessionId, target) => projectControl(target)?.id === sessionId });
  const task = (requestId: string): TaskDocument => ({
    path: `actio:task-${requestId}`, repoPath: project.repoPath, title: "Cc", body: "依頼",
    frontmatter: { task: `task-${requestId}`, project: "Cc", kind: "実装", created: "2026-11-25", working_session_id: null },
    runtime: { status: "pending", subsidiary_id: null, source_session: null, assignee: null, owner: null,
      delegation_run_id: null, pr_number: null, memoria_task_id: null, actio_task_id: "task-1", memoria_registration_state: "idle" },
  });
  const createTask = vi.fn<DeskRoutingPorts["createTask"]>(async (request) => {
    const document = task(request.id);
    tasks.set(document.path, document);
    return document;
  });
  const launch = vi.fn(options.launch ?? (async () => ({ ok: true as const })));
  const deliver = vi.fn();
  const delegate = vi.fn<DeskRoutingPorts["delegate"]>(async (request, _project, isRetry) => {
    runs.set(request.id, { id: "run", childSessionId: "sol", state: "active", isRetry });
    return true;
  });
  const dispatcher = new DeskRoutingDispatcher(repo, {
    now, id, projects, isCostBlocked: () => false, createTask, readTask: async (_repo, reference) => tasks.get(reference)!,
    assign: async (_repo, reference, next, expected) => {
      expect(tasks.get(reference)?.frontmatter.working_session_id).toBe(expected);
      tasks.get(reference)!.frontmatter.working_session_id = next;
    },
    projectControl, isProjectControl: (sessionId) => controllers.has(sessionId),
    launch, findSessionBySpawnId: (spawnId) => sessions.find((session) => session.spawnId === spawnId)?.id ?? null,
    delegationRun: (requestId) => runs.get(requestId) ?? null, delegate,
    hasResidentCapacity: () => true, canDeliver: () => true, deliver, onChange: () => {}, logError: () => {},
  });
  const submit = (body: string, key = "web:abcdefgh") => {
    const outcome = service.submit({ requestKey: key, requester: "author", provider: "claude", body });
    if (outcome.kind !== "created" && outcome.kind !== "existing") throw new Error(outcome.kind);
    return outcome.request.id;
  };
  const tick = async (advance = 0) => {
    time += advance;
    dispatcher.tick();
    await dispatcher.settle();
  };
  const drainDue = async () => {
    for (let count = 0; repo.dueForRouting(now()); count++) {
      if (count === 20) throw new Error("Desk routing did not settle");
      await tick();
    }
  };
  const advanceToRetry = (requestId: string) => {
    const retryAt = repo.find(requestId)?.retry_at;
    if (retryAt === undefined) throw new Error(`Missing retry time for Desk request ${requestId}`);
    time = Math.max(time, retryAt);
  };
  return { repo, service, createTask, delegate, deliver, launch, sessions, submit, tick, tasks, runs, drainDue,
    advanceToRetry,
    register(id: string, idle = true) {
      const session = { id, idle, spawnId: repo.projectLaunch(project.code)?.spawn_id ?? null };
      controllers.add(id);
      sessions.push(session);
      return session;
    },
  };
}

export async function observeDeskCapacity(h: ReturnType<typeof setup>) {
  const first = h.submit("[Cc] 先");
  await h.tick();
  h.register("control");
  h.advanceToRetry(first);
  await h.drainDue();
  const second = h.submit("[Cc] 次", "web:abcdefgh2");
  await h.drainDue();
  const third = h.submit("[Cc] 後", "web:abcdefgh3");
  await h.drainDue();

  const deliveries = () => h.deliver.mock.calls.map((call) => call[1] as string);
  const beforeCompletion = deliveries();
  const thirdDelivery = h.repo.find(third)?.delivery;
  h.tasks.get(h.repo.find(first)!.task_reference!)!.runtime!.status = "done";
  h.advanceToRetry(first);
  await h.drainDue();
  h.advanceToRetry(third);
  await h.drainDue();
  return { requestIds: [first, second, third], beforeCompletion, thirdDelivery,
    firstState: h.repo.find(first)?.state, afterCompletion: deliveries() };
}
// @ts-expect-error augur-inject
observeDeskCapacity = contract(observeDeskCapacity, { ...augurContract_a3b2cc89, contractId: 'desk-capacity-test-C-103', mode: 'observe', sample: 1, where: 'src/desk/routing.test.ts:88', rule: 'contract-wrap', id: 'a3b2cc89' }); /* augur-inject:contract-wrap:a3b2cc89 */

describe("Actio 依頼のルーティング", () => {
  it("最新予約の管制だけを使い、重複登録は確定しない", () => {
    const old = { id: "old", idle: true, spawnId: "1" };
    const current = { id: "current", idle: false, spawnId: "2" };
    expect(currentProjectControl([old, current], "2")).toBe(current);
    expect(currentProjectControl([old], "2")).toBeNull();
    expect(currentProjectControl([current, { ...current, id: "duplicate" }], "2")).toBeNull();
    expect(currentProjectControl([{ id: "unmarked", idle: true, spawnId: null }], null)).toBeNull();
    expect(canOfferDeskRequest(1)).toBe(true);
    expect(canOfferDeskRequest(2)).toBe(false);
  });

  it("曖昧な本文は判断待ちに置き、明示指定の後にだけタスクを作る", async () => {
    const h = setup();
    const request = h.submit("Cc と Actio を比較");
    expect(resolveDeskProject("[Cc] Cc と Actio を比較", [project, otherProject])).toBe(project);
    await h.tick();
    expect(h.repo.find(request)?.routing_issue).toBe("project");
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.service.selectProject(request, "Cc")?.project_code).toBe("Cc");
    await h.tick();
    expect(h.createTask).toHaveBeenCalledOnce();
    expect(h.repo.find(request)?.task_reference).toBe("actio:task-1");
  });

  it("同じ受付からタスクを一度作り、専任管制が承認したら子に委託する", async () => {
    const h = setup();
    const request = h.submit("[Cc] 依頼");
    expect(h.submit("[Cc] 依頼")).toBe(request);
    await h.tick();
    const controller = h.register("control", false);
    await h.tick(10_000);
    await h.tick();
    await h.tick();
    expect(h.createTask).toHaveBeenCalledOnce();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.launch).toHaveBeenCalledOnce();
    controller.idle = true;
    await h.tick(10_000);
    expect(h.deliver).toHaveBeenCalledWith("control", request, "actio:task-1");
    expect(h.delegate).not.toHaveBeenCalled();
    expect(h.service.claim(request, "other")).toBeNull();
    expect(h.service.claim(request, "control")?.delivery).toBe("claimed");
    await h.tick(60_000);
    expect(h.delegate).toHaveBeenCalledWith(expect.objectContaining({ id: request, session_id: "control" }), project, false);
  });

  it("管制交代後に同じ依頼を渡し、旧管制が復帰しても既存の子を重複起動しない", async () => {
    const h = setup();
    const request = h.submit("[Cc] 依頼");
    await h.tick();
    const old = h.register("old");
    await h.tick(10_000);
    await h.tick();
    await h.tick();
    expect(h.deliver).toHaveBeenCalledWith("old", request, "actio:task-1");
    expect(h.service.claim(request, "old")?.delivery).toBe("claimed");
    await h.tick(60_000);
    h.sessions.length = 0;
    await h.tick(60_000);
    expect(h.service.claim(request, "old")).toBeNull();
    await h.tick();
    h.register("new");
    h.sessions.push(old);
    await h.tick(10_000);
    await h.tick();
    await h.tick();
    expect(h.launch).toHaveBeenCalledTimes(2);
    expect(h.deliver).toHaveBeenLastCalledWith("new", request, "actio:task-1");
    expect(h.service.claim(request, "new")?.delivery).toBe("claimed");
    await h.tick(60_000);
    expect(h.delegate).toHaveBeenCalledOnce();
  });

  it("確認待ちの起動を同一プロジェクトで重ねず期限切れを記録する", async () => {
    const h = setup();
    const first = h.submit("[Cc] 先");
    h.submit("[Cc] 後", "web:abcdefgh2");
    await h.tick();
    await h.tick();
    expect(h.launch).toHaveBeenCalledOnce();
    await h.tick(DESK_LAUNCH_CONFIRM_WINDOW_MS + 1);
    expect(h.repo.find(first)).toMatchObject({ state: "launch_failed", routing_issue: "launch" });
  });

  it("受付待ちの 2 件が枠を保持し、完了後に次の依頼を届ける", async () => {
    const observed = await observeDeskCapacity(setup());
    expect(observed.beforeCompletion).toEqual(observed.requestIds.slice(0, 2));
    expect(observed.thirdDelivery).toBe("waiting");
    expect(observed.firstState).toBe("finished");
    expect(observed.afterCompletion).toEqual(observed.requestIds);
  });

  it("終了した子の失敗を 1 回だけ再委託する", async () => {
    const h = setup();
    const request = h.submit("[Cc] 依頼");
    await h.tick();
    h.register("control");
    await h.tick(10_000);
    await h.tick();
    await h.tick();
    h.service.claim(request, "control");
    await h.tick(60_000);
    h.runs.get(request)!.state = "failed";
    await h.tick(60_000);
    expect(h.delegate).toHaveBeenCalledOnce();
    h.runs.get(request)!.state = "retryable";
    await h.tick(60_000);
    expect(h.delegate).toHaveBeenLastCalledWith(expect.objectContaining({ id: request }), project, true);
    h.runs.get(request)!.state = "retryable";
    await h.tick(60_000);
    expect(h.delegate).toHaveBeenCalledTimes(2);
    expect(h.repo.find(request)?.routing_issue).toBe("delivery");
  });
});
