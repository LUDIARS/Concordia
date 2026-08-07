import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ChatRepo } from "../db/chat-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TasksRepo } from "../db/tasks-repo.js";
import { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import { makeChatReadModel } from "./chat-read-models.js";

// 状態カードの単位テストでは外部プローブを切り離し、DB の usage frame 配線だけを検証する。
vi.mock("../anatomia/cache-stats-client.js", () => ({ fetchSessionCacheStats: vi.fn(async () => null) }));
vi.mock("../harness/data-sufficiency.js", () => ({ probeProjectSufficiency: vi.fn(async () => null) }));
// context-estimate は channel-cost-cache 等も別の export を使うので、差し替えは
// ファイル探索を伴う estimateContextTokens だけに留める (全 export 置換だと
// 未定義 export へのアクセスで無関係な経路が壊れる)。
vi.mock("../cost/context-estimate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cost/context-estimate.js")>()),
  estimateContextTokens: vi.fn(async () => null),
}));

describe("makeChatReadModel.getSessionStatusSnapshot", () => {
  let sessions: SessionsRepo;
  let delegation: DelegationRepo;
  let transcriptLogs: TranscriptLogsRepo;
  let readModel: ReturnType<typeof makeChatReadModel>;

  beforeEach(() => {
    const db = makeTestDb();
    sessions = new SessionsRepo(db);
    delegation = new DelegationRepo(db);
    transcriptLogs = new TranscriptLogsRepo(db);
    readModel = makeChatReadModel({
      chatRepo: new ChatRepo(db),
      sessionsRepo: sessions,
      sessionTaskRecordsRepo: new SessionTaskRecordsRepo(db),
      tasksRepo: new TasksRepo(db),
      prRecordsRepo: new PrRecordsRepo(db),
      delegationRepo: delegation,
      usageFrames: transcriptLogs,
    });
  });

  it("codex-sdk の codex_usage frame を状態カードのコストへ反映する", async () => {
    sessions.insertSession({
      id: "codex-sdk-session",
      provider: "codex-sdk",
      repo_path: "E:/Document/Ars/Concordia",
      repo_origin: null,
      branch: "fix/cost",
      host: "test-host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: JSON.stringify({ model: "gpt-5.6-sol" }),
    });
    transcriptLogs.insert({
      session_id: "codex-sdk-session",
      seq: 1,
      ts: 1,
      kind: "raw",
      payload: {
        type: "codex_usage",
        thread_id: "thread-1",
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 10,
        total_tokens: 110,
      },
    });

    const snapshot = await readModel.getSessionStatusSnapshot("codex-sdk-session", "channel-1");

    expect(snapshot?.costBadge).toContain("110 tok");
  });

  it("runtime model review の metadata は delegation 起動時の設定より優先する", () => {
    delegation.createRun({
      id: "run-runtime-review",
      template_id: null,
      call_name: "codex-impl",
      target_provider: "codex",
      args: {},
      rendered_prompt: "implement",
      prompt_file_path: "prompt.md",
      spawn_pid: 1,
      spawn_command: ["codex"],
      triggered_by: "web-spawn",
      status: "running",
      effective_model: "gpt-5.6-sol",
      effort_level: "xhigh",
    });
    sessions.insertSession({
      id: "runtime-reviewed-session",
      provider: "codex-cli",
      repo_path: "E:/Document/Ars/Concordia",
      repo_origin: null,
      branch: "main",
      host: "test-host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: JSON.stringify({
        delegation_run_id: "run-runtime-review",
        model: "gpt-5.6-terra",
        effort: "medium",
      }),
    });

    expect(readModel.getSessionRelayState("runtime-reviewed-session")).toMatchObject({
      model: "gpt-5.6-terra",
      effortLevel: "medium",
    });
  });

  it("Castra root ではなく claim 済みの子プロジェクトを状態カードの Repo として表示する", () => {
    sessions.insertSession({
      id: "castra-root-session",
      provider: "codex-cli",
      repo_path: "E:/Document/Ars",
      repo_origin: null,
      branch: "codex/concordia-card",
      host: "test-host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
      target_project: "E:/Document/Ars/Concordia",
    });

    expect(readModel.getSessionRelayState("castra-root-session")?.repoPath)
      .toBe("E:/Document/Ars/Concordia");
  });
});
