import { describe, it, expect, beforeEach } from "vitest";
import { DelegationQueue, DEFAULT_STALE_MS } from "./queue.js";
import { DelegationRepo, type DelegationRunRow } from "../db/delegation-repo.js";
import { makeTestDb } from "../../tests/helpers/db.js";

function makeRun(repo: DelegationRepo, status: DelegationRunRow["status"], overrides: Partial<{
  child_session_id: string | null;
  queue_payload_json: string | null;
}> = {}): DelegationRunRow {
  return repo.createRun({
    template_id: null,
    call_name: "impl-from-design",
    target_provider: "codex",
    args: {},
    rendered_prompt: "prompt",
    prompt_file_path: "/tmp/x.md",
    spawn_pid: status === "spawned" ? 111 : null,
    spawn_command: null,
    triggered_by: "test",
    status,
    child_session_id: overrides.child_session_id ?? null,
    queue_payload_json: overrides.queue_payload_json ?? null,
  });
}

describe("DelegationQueue", () => {
  let repo: DelegationRepo;
  let sessions: { findSession: (id: string) => { status: string } | null };
  let sessionStatus: Record<string, string>;
  let spawned: string[];
  let now: number;

  const makeQueue = (max: number) =>
    new DelegationQueue({
      repo,
      sessions,
      resolveMaxConcurrency: () => max,
      spawnQueued: async (run) => {
        spawned.push(run.id);
        repo.markRunSpawned(run.id, { status: "spawned", spawn_pid: 999, spawn_command: ["codex"] });
      },
      now: () => now,
    });

  beforeEach(() => {
    repo = new DelegationRepo(makeTestDb());
    sessionStatus = {};
    sessions = { findSession: (id) => (sessionStatus[id] ? { status: sessionStatus[id] } : null) };
    spawned = [];
    // repo.createRun は実時刻で created_at を打つので、 fake now もそこから進める。
    now = Date.now();
  });

  it("上限未満なら容量あり、 上限に達したら容量なし", () => {
    const queue = makeQueue(2);
    expect(queue.hasCapacity()).toBe(true);
    makeRun(repo, "spawned");
    makeRun(repo, "running");
    expect(queue.activeCount()).toBe(2);
    expect(queue.hasCapacity()).toBe(false);
  });

  it("上限 0 は無制限 (キュー無効)", () => {
    const queue = makeQueue(0);
    makeRun(repo, "spawned");
    makeRun(repo, "spawned");
    expect(queue.enabled()).toBe(false);
    expect(queue.hasCapacity()).toBe(true);
  });

  it("producer-only mode は上限 0 でも全実行を worker queue に渡し、自身では drain しない", async () => {
    const queue = new DelegationQueue({
      repo,
      sessions,
      resolveMaxConcurrency: () => 0,
      spawnQueued: async () => undefined,
      producerOnly: () => true,
    });
    expect(queue.enabled()).toBe(true);
    expect(queue.hasCapacity()).toBe(false);
    makeRun(repo, "queued", { queue_payload_json: "{}" });
    await queue.drain();
    expect(spawned).toEqual([]);
  });

  it("子セッションが終了済みの run はスロットを占有しない (status は書き換えない)", () => {
    const queue = makeQueue(1);
    const run = makeRun(repo, "running", { child_session_id: "s1" });
    sessionStatus["s1"] = "active";
    expect(queue.hasCapacity()).toBe(false);

    sessionStatus["s1"] = "ended";
    expect(queue.hasCapacity()).toBe(true);
    // 報告を怠っただけかもしれないので failed へは倒さない。
    expect(repo.findRun(run.id)!.status).toBe("running");
  });

  it("子セッション未紐付けのまま TTL 超過した run はスロットを占有しない", () => {
    const queue = makeQueue(1);
    makeRun(repo, "spawned");
    expect(queue.hasCapacity()).toBe(false);
    // created_at は実時刻なので、 TTL を確実に跨ぐよう 2 倍進める。
    now += DEFAULT_STALE_MS * 2;
    expect(queue.hasCapacity()).toBe(true);
  });

  it("drain は空きスロットの分だけ FIFO で起動する", async () => {
    const queue = makeQueue(2);
    makeRun(repo, "running", { child_session_id: "s1" });
    sessionStatus["s1"] = "active";
    const first = makeRun(repo, "queued", { queue_payload_json: "{}" });
    const second = makeRun(repo, "queued", { queue_payload_json: "{}" });

    await queue.drain();

    // 空きは 1 スロットだけ → 先頭の 1 件のみ起動し、 2 件目は queued のまま。
    expect(spawned).toEqual([first.id]);
    expect(repo.findRun(first.id)!.status).toBe("spawned");
    expect(repo.findRun(second.id)!.status).toBe("queued");
    expect(queue.position(second.id)).toBe(1);
  });

  it("上限 0 に変更すると待たせていた分を全部流す", async () => {
    const queue = makeQueue(0);
    const a = makeRun(repo, "queued", { queue_payload_json: "{}" });
    const b = makeRun(repo, "queued", { queue_payload_json: "{}" });
    await queue.drain();
    expect(spawned).toEqual([a.id, b.id]);
  });

  it("spawn が投げたら spawn_failed に倒して payload を落とす (無限再試行を防ぐ)", async () => {
    const queue = new DelegationQueue({
      repo,
      sessions,
      resolveMaxConcurrency: () => 4,
      spawnQueued: async () => { throw new Error("boom"); },
      now: () => now,
    });
    const run = makeRun(repo, "queued", { queue_payload_json: "{}" });
    await queue.drain();
    const after = repo.findRun(run.id)!;
    expect(after.status).toBe("spawn_failed");
    expect(after.error).toContain("boom");
    expect(after.queue_payload_json).toBeNull();
  });
});
