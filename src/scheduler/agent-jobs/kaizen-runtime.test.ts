import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { InstructionService } from "../../agent-instructions/instruction-service.js";
import { SqliteAgentInstructionStore } from "../../db/agent-instructions-repo.js";
import { createKaizenCloudPorts, type KaizenCloud } from "./kaizen-cloud.js";
import { createKaizenRuntime } from "./kaizen-runtime.js";
import { createKaizenStore } from "./kaizen-store.js";

describe("scheduled kaizen lifecycle", () => {
  it("only applies trusted registrations and collects returned work without resubmitting", async () => {
    vi.useFakeTimers();
    const db = makeTestDb();
    const store = createKaizenStore(db);
    const instructions = new InstructionService({ store: new SqliteAgentInstructionStore(db) });
    const proposed = { kind: "cloud_fix", title: "集計の修正", reason: "失敗が3件", target_repo: "Cc", instruction: "重複を除く" };
    const register = (key: string) => instructions.registerOnce({
      dedupeKey: key, params: { job: "kaizen-daily", dedupe_key: key }, type: "run_task", agent: "dots", title: "Kaizen", body: "Review",
    });
    const finish = (id: string) => instructions.recordResult(id, { agent: "dots", status: "done", summary: "提案", detail: { proposals: [proposed] } });
    finish(register("cron:kaizen-daily:spoofed").id);
    finish(store.register(() => register("cron:kaizen-daily:trusted")).id);
    const create = vi.fn(async () => ({ repoPath: "/cc", title: "集計の修正", body: "", path: "actio:one",
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
      store, instruction: (id) => instructions.record(id), cloud: () => cloud, enabled: () => true,
      ports: { ...createKaizenCloudPorts({ cloud: () => cloud, tasks: { create }, store, now: Date.now, repositoryKey: async (path) => path }),
        projects: () => new Map([["Cc", "/cc"]]), limit: () => 3, card },
      post, now: Date.now, warn: vi.fn(),
    });
    const stop = runtime.start();
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/cc", subsidiaryId: null, kind: "実装" }));
      expect(submitKaizen).toHaveBeenCalledOnce();
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
});
