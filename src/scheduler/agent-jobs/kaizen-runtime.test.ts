import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { InstructionService } from "../../agent-instructions/instruction-service.js";
import { SqliteAgentInstructionStore } from "../../db/agent-instructions-repo.js";
import { createKaizenCloudPorts, type KaizenCloud } from "./kaizen-cloud.js";
import { createKaizenRuntime } from "./kaizen-runtime.js";
import { createKaizenStore } from "./kaizen-store.js";

describe("scheduled kaizen lifecycle", () => {
  it.each(["kaizen-daily", "deps-sweep-daily"] as const)("%s applies trusted registrations and collects without resubmitting", async (job) => {
    vi.useFakeTimers();
    const db = makeTestDb();
    const store = createKaizenStore(db);
    const instructions = new InstructionService({ store: new SqliteAgentInstructionStore(db) });
    const depsSweep = job === "deps-sweep-daily";
    const proposed = { kind: "cloud_fix", title: depsSweep ? "example を更新" : "集計の修正",
      reason: depsSweep ? "修正版 1.2.4 が必要" : "失敗が3件", target_repo: "Cc",
      instruction: depsSweep ? "example を 1.2.3 から 1.2.4 に更新" : "重複を除く" };
    const register = (key: string) => instructions.registerOnce({
      dedupeKey: key, params: { job, dedupe_key: key, data: { repos: [{ code: "Cc" }] } },
      type: "run_task", agent: "dots", title: job, body: "Review",
    });
    const finish = (id: string) => instructions.recordResult(id, { agent: "dots", status: "done", summary: "提案",
      detail: { proposals: depsSweep ? [proposed, proposed, { ...proposed, target_repo: "Li" }] : [proposed] } });
    finish(register(`cron:${job}:spoofed`).id);
    const registration = () => store.register(() => register(`cron:${job}:trusted`));
    const trusted = registration();
    expect(registration().id).toBe(trusted.id);
    finish(trusted.id);
    const create = vi.fn(async () => ({ repoPath: "/cc", title: proposed.title, body: "", path: "actio:one",
      frontmatter: { task: "one", project: "Cc", kind: "実装", created: "" } }));
    const submitKaizen = vi.fn(async () => ({ state: "submitted" }));
    const collect = vi.fn()
      .mockRejectedValueOnce(new Error("cloud_git_result_not_received"))
      .mockResolvedValue({ state: "review_submitted" });
    const cloud: KaizenCloud = {
      authorize: vi.fn(),
      runtime: { kaizenTarget: async () => "codex", submitKaizen, collect,
        attemptJournal: async () => ({ intent: true, receipt: { state: "submitted", remoteId: "task_one" },
          reconciliationRemoteId: null, verified: false }) },
    };
    const post = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const card = vi.fn();
    const runtime = createKaizenRuntime({
      store, instruction: (id) => instructions.record(id), cloud: () => cloud, enabled: (name) => name === job,
      ports: { ...createKaizenCloudPorts({ cloud: () => cloud, tasks: { create }, store, now: Date.now, repositoryKey: async (path) => path }),
        projects: () => new Map([["Cc", "/cc"], ["Li", "/li"]]), limit: () => 3, card },
      post, now: Date.now, warn: vi.fn(),
    });
    const stop = runtime.start();
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/cc", subsidiaryId: null, kind: "実装" }));
      expect(submitKaizen).toHaveBeenCalledOnce();
      expect(submitKaizen).toHaveBeenCalledWith({ repositoryKey: "/cc", subsidiaryId: null },
        expect.objectContaining({ instruction: expect.stringContaining(depsSweep ? "lockfile" : proposed.instruction) }),
        expect.any(Function), job);
      expect(collect).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledTimes(2);
      expect(card).not.toHaveBeenCalled();
    } finally {
      stop();
      await runtime.waitForIdle();
      db.close();
      vi.useRealTimers();
    }
  });

  it.each([true, false])("posts the dependency findings without submitting when stopped or report-only (%s)", async (stopped) => {
    vi.useFakeTimers();
    const db = makeTestDb();
    const store = createKaizenStore(db);
    const instructions = new InstructionService({ store: new SqliteAgentInstructionStore(db) });
    const job = "deps-sweep-daily";
    const key = `cron:${job}:trusted`;
    const { id } = store.register(() => instructions.registerOnce({
      dedupeKey: key, params: { job, dedupe_key: key, data: { repos: [{ code: "Cc" }] } },
      type: "run_task", agent: "dots", title: "日次依存関係点検", body: "Review",
    }));
    const proposal = { kind: "cloud_fix", title: "example を更新", reason: "修正版あり", target_repo: "Cc",
      instruction: "example を 1.2.3 から 1.2.4 に更新" };
    instructions.recordResult(id, { agent: "dots", status: "done", summary: "点検完了",
      detail: { items: ["example 1.2.3 を確認"], ...(stopped ? { proposals: [proposal] } : {}) } });
    const post = vi.fn(async () => true);
    const submit = vi.fn();
    const target = vi.fn();
    const enabled = vi.fn((name: string) => name === "kaizen-daily" || !stopped);
    const runtime = createKaizenRuntime({
      store, instruction: (instructionId) => instructions.record(instructionId), cloud: () => undefined, enabled,
      ports: { projects: () => new Map([["Cc", "/cc"]]), limit: () => 3, card: vi.fn(), target, submit },
      post, now: Date.now, warn: vi.fn(),
    });
    const stop = runtime.start();
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(target).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("example 1.2.3 を確認"));
      if (stopped) expect(enabled).toHaveBeenCalledWith(job);
    } finally {
      stop();
      await runtime.waitForIdle();
      db.close();
      vi.useRealTimers();
    }
  });
});
