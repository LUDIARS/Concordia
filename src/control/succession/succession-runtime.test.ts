/**
 * 実行時配線 (succession-runtime / session-succession-wiring) を実 DB (in-memory) の repo で組み、
 * route と監視が共有するサービスが実 I/O の port で動くことを確かめる。 spawn は呼ばない経路だけを通す。
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { ChatRepo } from "../../db/chat-repo.js";
import { ControlJobsRepo } from "../../db/control-jobs-repo.js";
import { SessionsRepo } from "../../db/sessions-repo.js";
import { TranscriptLogsRepo } from "../../db/transcript-logs-repo.js";
import { eventBus } from "../../events.js";
import { readRepoAgents } from "./repo-agents-state.js";
import { buildSuccessionRuntime } from "./succession-runtime.js";

const CHECKOUT = "E:/Document/Ars/Concordia/.wt-x";

function setup() {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const transcriptLogs = new TranscriptLogsRepo(db);
  const runtime = buildSuccessionRuntime({
    sessions,
    chat: new ChatRepo(db),
    transcriptLogs,
    controlJobs: new ControlJobsRepo(db),
    runClaude: async () => ({ ok: true, stdout: "要約", stderr: "" }),
    toSpawnProvider: (provider) => (provider === "claude-code" ? "claude" : null),
    forceExitGraceMs: 0,
    registeredRepos: () => ["E:/Document/Ars/Concordia"],
    projectCodeFor: () => "Cc",
    workspaceRoots: () => ["E:/Document/Ars"],
    childThread: () => null,
    hasUnansweredQuestion: () => false,
    readContextTokens: async () => null,
    env: {},
    intervalMs: 60_000,
    log: { info: () => undefined, warn: () => undefined },
  });
  const insert = (id: string, repoPath: string, metadata: Record<string, unknown> | null = null) => sessions.insertSession({
    id, provider: "claude-code", repo_path: repoPath, repo_origin: null, branch: null, host: "h",
    started_at: 1, last_seen_at: 1, transcript_path: null, metadata: metadata ? JSON.stringify(metadata) : null,
  });
  return { runtime, sessions, transcriptLogs, insert };
}

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

describe("buildSuccessionRuntime", () => {
  it("ゲート契機の行を実 repo の metadata に書き、 一覧で読める", () => {
    const { runtime, sessions, insert } = setup();
    insert("parent", "E:/Document/Ars");
    const text = runtime.repoAgents.onGateDenied({
      sessionId: "parent", hits: [{ rule: "task-branch", decision: "deny" }], cwd: CHECKOUT, filePath: null,
    });
    expect(text).toContain("```repo-brief");
    const metadata = JSON.parse(sessions.findSession("parent")!.metadata ?? "{}") as Record<string, unknown>;
    expect(readRepoAgents(metadata)).toMatchObject([{ checkout: CHECKOUT, status: "requested" }]);
    expect(runtime.repoAgents.list("parent")).toHaveLength(1);
  });

  it("start 後は子の session.ended で親の行が ended になり、 stop で購読をやめる", () => {
    const { runtime, sessions, transcriptLogs, insert } = setup();
    insert("parent", "E:/Document/Ars", {
      repo_agents: [{ checkout: CHECKOUT, project_code: "Cc", trigger: "gate", rule: null, status: "active", at: 1,
        updated_at: 1, spawn_id: "s", child_session_id: "child", pending_brief: null, note: null }],
    });
    insert("child", CHECKOUT, { repo_agent_of: { parent_session_id: "parent", checkout: CHECKOUT, project_code: "Cc" } });
    transcriptLogs.insert({ session_id: "child", seq: 1, ts: 2, kind: "text", payload: { role: "assistant", text: "PR #5 を出しました" } });
    const handle = runtime.start();
    stop = () => handle.stop();

    eventBus.emit({ type: "session.ended", session_id: "child", ts: 3 });
    const rows = readRepoAgents(JSON.parse(sessions.findSession("parent")!.metadata ?? "{}") as Record<string, unknown>);
    expect(rows[0]?.status).toBe("ended");
    const injected = sessions.eventsByKind("parent", "inject").map((event) => JSON.parse(event.payload) as { text: string });
    expect(injected.at(-1)?.text).toContain("PR: #5");
  });

  it("handover は前提を満たさなければ spawn せずに理由を返す (route と同じサービス)", async () => {
    const { runtime, insert } = setup();
    insert("plain", "E:/Document/Ars/Concordia");
    expect(await runtime.succession.handover("plain")).toEqual({
      ok: false, status: 400, error: "not lictor-wrapped: session has no metadata — was it lictor-wrapped?",
    });
    expect(await runtime.succession.relictor("missing")).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});
