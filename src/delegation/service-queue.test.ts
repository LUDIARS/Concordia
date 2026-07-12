/**
 * DelegationService × DelegationQueue の結合 (invoke → queued → drain → spawn)。
 * service 単体の render/spawn は service.test.ts、 スロット計算は queue.test.ts。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { DelegationService } from "./service.js";
import { DelegationQueue } from "./queue.js";

describe("delegation queue × service", () => {
  let repo: DelegationRepo;
  let service: DelegationService;
  let queue: DelegationQueue;
  let promptsDir: string;
  let spawnCalls: number;
  let maxConcurrency: number;

  beforeEach(() => {
    promptsDir = mkdtempSync(join(tmpdir(), "concordia-queue-"));
    repo = new DelegationRepo(makeTestDb());
    repo.upsertTemplate({
      call_name: "impl-from-design",
      title: "実装",
      target_provider: "codex",
      prompt_template: "実装して: ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
    });
    spawnCalls = 0;
    maxConcurrency = 1;
    service = new DelegationService({
      repo,
      promptsDir,
      spawn: () => {
        spawnCalls += 1;
        return { ok: true, pid: 4242, command: ["codex"] };
      },
    });
    queue = new DelegationQueue({
      repo,
      sessions: { findSession: () => null },
      resolveMaxConcurrency: () => maxConcurrency,
      spawnQueued: (run) => service.spawnQueuedRun(run),
    });
    service.setQueue(queue);
  });

  afterEach(() => rmSync(promptsDir, { recursive: true, force: true }));

  it("上限内なら即 spawn する", async () => {
    const r = await service.invoke({ call_name: "impl-from-design", args: { task: "A" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.queued).toBe(false);
    expect(r.run.status).toBe("spawned");
    expect(r.spawn_pid).toBe(4242);
    expect(spawnCalls).toBe(1);
  });

  it("producer-only mode は空きスロットがあっても spawn せず永続キューへ渡す", async () => {
    const producerQueue = new DelegationQueue({
      repo,
      sessions: { findSession: () => null },
      resolveMaxConcurrency: () => 0,
      spawnQueued: (run) => service.spawnQueuedRun(run),
      producerOnly: () => true,
    });
    service.setQueue(producerQueue);
    const result = await service.invoke({ call_name: "impl-from-design", args: { task: "worker" } });
    expect(result.ok && result.queued).toBe(true);
    expect(spawnCalls).toBe(0);
    if (result.ok) expect(result.run.status).toBe("queued");
  });

  it("上限に達していたら spawn せず queued にする (prompt file も作らない)", async () => {
    await service.invoke({ call_name: "impl-from-design", args: { task: "A" } });
    const r = await service.invoke({ call_name: "impl-from-design", args: { task: "B" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.queued).toBe(true);
    expect(r.queue_position).toBe(1);
    expect(r.run.status).toBe("queued");
    expect(r.spawn_pid).toBeNull();
    expect(spawnCalls).toBe(1); // 2 件目は起動していない
    // 起動時までは副作用を作らない (prompt file は spawn 直前に書く)。
    expect(existsSync(r.run.prompt_file_path)).toBe(false);
    // 起動入力は payload に退避されている。
    expect(r.run.queue_payload_json).toBeTruthy();
  });

  it("スロットが空いたら drain が queued を起動し、 payload を落とす", async () => {
    const first = await service.invoke({ call_name: "impl-from-design", args: { task: "A" } });
    const second = await service.invoke({ call_name: "impl-from-design", args: { task: "B" } });
    expect(second.ok && second.queued).toBe(true);
    if (!first.ok || !second.ok) return;

    // 1 件目が完了 → スロットが空く。
    repo.updateRunStatus(first.run.id, "completed");
    await queue.drain();

    const after = repo.findRun(second.run.id)!;
    expect(after.status).toBe("spawned");
    expect(after.spawn_pid).toBe(4242);
    expect(after.queue_payload_json).toBeNull();
    expect(spawnCalls).toBe(2);
    // 起動時に prompt file が書かれる (run.id と同名 = 事前確保した path)。
    expect(existsSync(after.prompt_file_path)).toBe(true);
    // 起動プロンプトは queued 時に render 済みのものがそのまま使われる。
    expect(after.rendered_prompt).toContain("実装して: B");
  });

  it("spawn=false (render のみ) はキューを通らない", async () => {
    await service.invoke({ call_name: "impl-from-design", args: { task: "A" } });
    const r = await service.invoke({ call_name: "impl-from-design", args: { task: "B" }, spawn: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.queued).toBe(false);
    expect(r.run.status).toBe("pending");
  });
});
