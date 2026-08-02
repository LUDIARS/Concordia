import { describe, it, expect, beforeEach } from "vitest";
import { DelegationQueue, DEFAULT_STALE_MS } from "./queue.js";
import { DelegationRepo, type DelegationRunRow } from "../db/delegation-repo.js";
import { makeTestDb } from "../../tests/helpers/db.js";
import type Database from "better-sqlite3";
import { delegationQueueClaim } from "./lease.js";

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
  let db: Database.Database;
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
        repo.markRunSpawned(
          run.id,
          { status: "spawned", spawn_pid: 999, spawn_command: ["codex"] },
          delegationQueueClaim(run),
        );
      },
      now: () => now,
    });

  beforeEach(() => {
    db = makeTestDb();
    repo = new DelegationRepo(db);
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

  it("claim と launch intent を同じ transaction で outbox に残す", () => {
    const run = makeRun(repo, "queued", { queue_payload_json: "{}" });
    const claimed = repo.claimNextQueuedRun({ owner: "worker-a", now, leaseMs: 1_000, maxConcurrency: 1, activeCount: 0 });
    expect(claimed?.id).toBe(run.id);
    expect(claimed?.status).toBe("launching");
    const outbox = db.prepare(
      `SELECT status, owner, fencing_token FROM delegation_outbox WHERE run_id = ?`,
    ).get(run.id);
    expect(outbox).toEqual({ status: "pending", owner: "worker-a", fencing_token: 1 });
  });

  it("expired claimを再取得しても古いfencing tokenでは完了できない", () => {
    const run = makeRun(repo, "queued", { queue_payload_json: "{}" });
    const first = repo.claimNextQueuedRun({ owner: "worker-a", now, leaseMs: 10, maxConcurrency: 1, activeCount: 0 })!;
    const second = repo.claimNextQueuedRun({ owner: "worker-b", now: now + 11, leaseMs: 10, maxConcurrency: 1, activeCount: 0 })!;
    expect(second.queue_fencing_token).toBe(2);
    expect(repo.markRunSpawned(
      run.id,
      { status: "spawned", spawn_pid: 1, spawn_command: ["codex"] },
      delegationQueueClaim(first),
    )).toBeNull();
    expect(repo.findRun(run.id)?.status).toBe("launching");
  });

  it("claim は渡された activeCount が上限に達していれば払い出さない", () => {
    makeRun(repo, "queued", { queue_payload_json: "{}" });
    expect(repo.claimNextQueuedRun({
      owner: "worker-a", now, leaseMs: 1_000, maxConcurrency: 1, activeCount: 1,
    })).toBeNull();
  });

  it("claim は activeCount が上限未満なら払い出す", () => {
    const waiting = makeRun(repo, "queued", { queue_payload_json: "{}" });
    expect(repo.claimNextQueuedRun({
      owner: "worker-a", now, leaseMs: 1_000, maxConcurrency: 2, activeCount: 1,
    })?.id).toBe(waiting.id);
  });

  // 2026-07-31 の実障害の回帰テスト。spawn 後にプロセスが落ちても status は
  // 'running' のまま残るので、claim が status を生に数えていた頃は死んだ run が
  // 枠を食い続け、queued が二度と払い出されなくなった (実稼働 2 本に対し DB 上
  // 142 本が active 扱いになり、上限 4 を超えて完全停止)。
  it("子セッションが終了した run が残っていても drain は払い出す", async () => {
    const queue = makeQueue(1);
    const dead = makeRun(repo, "running", { child_session_id: "session-dead" });
    sessionStatus["session-dead"] = "ended";
    const waiting = makeRun(repo, "queued", { queue_payload_json: "{}" });

    expect(queue.activeCount()).toBe(0);
    await queue.drain();

    expect(spawned).toEqual([waiting.id]);
    // 報告漏れの可能性があるので、死んだ run の status は書き換えない。
    expect(repo.findRun(dead.id)!.status).toBe("running");
  });

  // 長く待たされた queued run は spawn 直後から「紐付け待ちのまま TTL 超過」に見えるので、
  // 占有数を数え直すだけでは 1 本も計上されず上限を素通りしてしまう。 払い出した分は
  // drain 側で数える。
  it("TTL より長く待たされた queued run でも上限を超えて払い出さない", async () => {
    const queue = makeQueue(1);
    const first = makeRun(repo, "queued", { queue_payload_json: "{}" });
    makeRun(repo, "queued", { queue_payload_json: "{}" });

    now += DEFAULT_STALE_MS * 2;
    await queue.drain();

    expect(spawned).toEqual([first.id]);
  });

  it("紐付け待ちのまま TTL を超えた run が残っていても drain は払い出す", async () => {
    const queue = makeQueue(1);
    makeRun(repo, "spawned");
    const waiting = makeRun(repo, "queued", { queue_payload_json: "{}" });

    // TTL 内はまだ枠を占有している。
    await queue.drain();
    expect(spawned).toEqual([]);

    now += DEFAULT_STALE_MS * 2;
    await queue.drain();
    expect(spawned).toEqual([waiting.id]);
  });

  // 払い出した分を無条件に 1 枠と数えると、 spawn 失敗が続く backlog が 1 drain あたり
  // 上限本ずつしか流れなくなる (executeQueuedRun は payload 欠損などを throw せず
  // spawn_failed に倒すので、 実運用でも起きる)。 倒れた run は同じパスで枠を返す。
  it("spawn に失敗した run は同じ drain パスで枠を返す", async () => {
    const queue = new DelegationQueue({
      repo,
      sessions,
      resolveMaxConcurrency: () => 1,
      spawnQueued: async () => { throw new Error("boom"); },
      now: () => now,
    });
    const first = makeRun(repo, "queued", { queue_payload_json: "{}" });
    const second = makeRun(repo, "queued", { queue_payload_json: "{}" });

    await queue.drain();

    expect(repo.findRun(first.id)!.status).toBe("spawn_failed");
    expect(repo.findRun(second.id)!.status).toBe("spawn_failed");
  });
});
