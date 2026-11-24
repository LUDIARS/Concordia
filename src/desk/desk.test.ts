import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import {
  DESK_LAUNCH_CONFIRM_WINDOW_MS,
  buildDeskStartupPrompt,
  canTransition,
  decideSubmission,
  deskBodyProblem,
  discordRequestKey,
  originOfRequestKey,
  parseDeskMessage,
  webRequestKey,
  type DeskRequest,
} from "./desk-request-policy.js";
import { DeskDispatcher, type DeskLaunchResult } from "./dispatcher.js";
import { DeskRepository } from "./repository.js";
import { DeskService } from "./service.js";

function setup(options: { enabled?: () => boolean; blocked?: () => boolean; launch?: (request: DeskRequest, spawnId: string) => Promise<DeskLaunchResult> } = {}) {
  const db = makeTestDb();
  const repo = new DeskRepository(db);
  let now = 1_000_000;
  let seq = 0;
  const sessions = new Map<string, string>();
  const ended = new Set<string>();
  const launches: Array<{ id: string; spawnId: string }> = [];
  const service = new DeskService(repo, { now: () => now, id: () => `req-${++seq}`, isEnabled: options.enabled ?? (() => true) });
  const changes: string[] = [];
  const dispatcher = new DeskDispatcher(repo, {
    now: () => now,
    id: () => `spawn-${++seq}`,
    isEnabled: options.enabled ?? (() => true),
    isCostBlocked: options.blocked ?? (() => false),
    launch: async (request, spawnId) => {
      launches.push({ id: request.id, spawnId });
      return options.launch ? options.launch(request, spawnId) : { ok: true };
    },
    findSessionBySpawnId: (spawnId) => sessions.get(spawnId) ?? null,
    isSessionEnded: (sessionId) => (ended.has(sessionId) ? true : sessions.size ? false : null),
    onChange: (request) => changes.push(request.state),
    logError: () => {},
  });
  return { db, repo, service, dispatcher, launches, sessions, ended, changes, advance: (ms: number) => { now += ms; } };
}

const submit = (service: DeskService, key = "web:abcdefgh-1", body = "依頼です") =>
  service.submit({ requestKey: key, requester: "neco", provider: "claude", body });

describe("依頼窓口の業務判断 (desk-request-policy)", () => {
  it("builds request keys per surface and rejects malformed ones", () => {
    expect(webRequestKey("abcdefgh-1")).toBe("web:abcdefgh-1");
    expect(webRequestKey("short")).toBeNull();
    expect(discordRequestKey("123", "456")).toBe("discord:123:456");
    expect(discordRequestKey("abc", "456")).toBeNull();
    expect(originOfRequestKey("web:abcdefgh-1")).toBe("web");
    expect(originOfRequestKey("discord:1:2")).toBe("discord");
    expect(originOfRequestKey("chores:1")).toBeNull();
  });

  it("parses the [codex] prefix and validates the body", () => {
    expect(parseDeskMessage("[codex]  直して")).toEqual({ provider: "codex", body: "直して" });
    expect(parseDeskMessage("調べて")).toEqual({ provider: "claude", body: "調べて" });
    expect(deskBodyProblem("   ")).not.toBeNull();
    expect(deskBodyProblem("あ".repeat(16_001))).not.toBeNull();
    expect(deskBodyProblem("ok")).toBeNull();
  });

  it("only allows forward transitions", () => {
    expect(canTransition("accepted", "launching")).toBe(true);
    expect(canTransition("launch_unknown", "running")).toBe(true);
    expect(canTransition("running", "launching")).toBe(false);
    expect(canTransition("launch_failed", "launching")).toBe(false);
  });

  it("treats a same-content resubmission as existing and different content as a conflict (CC-V5-INV-01)", () => {
    expect(decideSubmission(null, { body: "a", provider: "claude" })).toBe("create");
    expect(decideSubmission({ body: "a", provider: "claude" }, { body: " a ", provider: "claude" })).toBe("existing");
    expect(decideSubmission({ body: "a", provider: "claude" }, { body: "b", provider: "claude" })).toBe("conflict");
  });

  it("asks the launched session to create and link the Actio task itself (実装メモ 1)", () => {
    const prompt = buildDeskStartupPrompt({ id: "12345678-x", request_key: "web:abcdefgh-1", requester: "neco", body: "本文" }, "http://cc/");
    expect(prompt).toContain("http://cc/v1/sessions/<あなたの session id>/task-links");
    expect(prompt).toContain("本文");
  });
});

describe("依頼の受付と起動 (CC-V5-INV-01)", () => {
  it("accepts a request key once and launches it exactly once", async () => {
    const h = setup();
    const first = submit(h.service);
    const again = submit(h.service);
    expect(first.kind).toBe("created");
    expect(again.kind).toBe("existing");
    expect(submit(h.service, "web:abcdefgh-1", "別の依頼").kind).toBe("conflict");
    h.dispatcher.tick();
    h.dispatcher.tick();
    await h.dispatcher.settle();
    h.dispatcher.tick();
    await h.dispatcher.settle();
    expect(h.launches).toHaveLength(1);
    const row = h.repo.findByKey("web:abcdefgh-1")!;
    expect(row.state).toBe("launching");
    expect(row.spawn_id).toBe(h.launches[0]!.spawnId);
    h.sessions.set(row.spawn_id!, "session-1");
    h.dispatcher.tick();
    expect(h.repo.find(row.id)).toMatchObject({ state: "running", session_id: "session-1" });
    h.ended.add("session-1");
    h.dispatcher.tick();
    expect(h.repo.find(row.id)?.state).toBe("finished");
    expect(h.launches).toHaveLength(1);
    expect(h.changes).toEqual(["launching", "running", "finished"]);
  });

  it("reconciles an unknown launch by spawn id instead of launching again", async () => {
    const h = setup({ launch: async () => { throw new Error("connection reset"); } });
    submit(h.service);
    h.dispatcher.tick();
    await h.dispatcher.settle();
    const row = h.repo.findByKey("web:abcdefgh-1")!;
    expect(row.state).toBe("launch_unknown");
    h.dispatcher.tick();
    await h.dispatcher.settle();
    expect(h.launches).toHaveLength(1);
    h.sessions.set(row.spawn_id!, "session-9");
    h.dispatcher.tick();
    expect(h.repo.find(row.id)).toMatchObject({ state: "running", session_id: "session-9", spawn_id: row.spawn_id });
  });

  it("fails a launch that does not register within 5 minutes and never relaunches it", async () => {
    const h = setup();
    submit(h.service);
    h.dispatcher.tick();
    await h.dispatcher.settle();
    h.advance(DESK_LAUNCH_CONFIRM_WINDOW_MS + 1);
    h.dispatcher.tick();
    await h.dispatcher.settle();
    const row = h.repo.findByKey("web:abcdefgh-1")!;
    expect(row.state).toBe("launch_failed");
    h.dispatcher.tick();
    await h.dispatcher.settle();
    expect(h.launches).toHaveLength(1);
  });

  it("records a rejected spawn as launch_failed", async () => {
    const h = setup({ launch: async () => ({ ok: false, error: "spawn refused" }) });
    submit(h.service);
    h.dispatcher.tick();
    await h.dispatcher.settle();
    expect(h.repo.findByKey("web:abcdefgh-1")).toMatchObject({ state: "launch_failed", error: "spawn refused" });
  });

  it("keeps accepted requests waiting while the cost limit blocks or the desk is off", async () => {
    let blocked = true;
    const h = setup({ blocked: () => blocked });
    submit(h.service);
    h.dispatcher.tick();
    await h.dispatcher.settle();
    expect(h.launches).toHaveLength(0);
    expect(h.repo.findByKey("web:abcdefgh-1")?.state).toBe("accepted");
    blocked = false;
    h.dispatcher.tick();
    await h.dispatcher.settle();
    expect(h.launches).toHaveLength(1);
  });

  it("refuses new requests while disabled but still answers a resubmission of an accepted one", () => {
    let enabled = true;
    const h = setup({ enabled: () => enabled });
    submit(h.service);
    enabled = false;
    expect(submit(h.service).kind).toBe("existing");
    expect(submit(h.service, "web:abcdefgh-2").kind).toBe("disabled");
  });

  it("does not let a losing CAS launch twice", async () => {
    const h = setup();
    submit(h.service);
    const row = h.repo.findByKey("web:abcdefgh-1")!;
    // 別の手が先に進めた行で起動しようとしても何もしない。
    h.repo.transition(row, { state: "launching", spawn_id: "other", launch_deadline_at: 1 }, 1);
    const launch = vi.fn();
    h.dispatcher.tick();
    await h.dispatcher.settle();
    expect(launch).not.toHaveBeenCalled();
    expect(h.launches).toHaveLength(0);
  });
});
