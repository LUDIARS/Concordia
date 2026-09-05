import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import type { SocketModeClient } from "@slack/socket-mode";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeSlackConfigRepo } from "../db/slack-config-repo.js";
import type { ChatReadModel } from "../platform/chat-read-model.js";
import { writeCustomWorkflows } from "../platform/reaction-workflow.js";
import { eventBus } from "../events.js";
import { startSlackBot } from "./bot.js";

let tempDir = "";
let customWorkflowsPath = "";

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "concordia-slack-session-channels-"));
  customWorkflowsPath = join(tempDir, "custom-reaction-workflows.json");
  await writeCustomWorkflows(customWorkflowsPath, [{
    kind: "skill",
    emoji: "👍",
    skill: "impl",
    mode: "inject",
    cwd: "repo",
    action: "start-impl",
  }]);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

interface FakeSocket {
  handlers: Map<string, (payload: never) => Promise<void> | void>;
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, (payload: never) => Promise<void> | void>();
  return {
    handlers,
    on: vi.fn((name: string, handler: (payload: never) => Promise<void> | void) => { handlers.set(name, handler); }),
    start: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
}

function makeWeb() {
  let channelSequence = 0;
  return {
    auth: { test: vi.fn(async () => ({ user_id: "BOT" })) },
    conversations: {
      create: vi.fn(async ({ name }: { name: string }) => ({ channel: { id: `C${++channelSequence}`, name } })),
      list: vi.fn(async () => ({ channels: [] })),
      setTopic: vi.fn(async () => ({ ok: true })),
      setPurpose: vi.fn(async () => ({ ok: true })),
      archive: vi.fn(async () => ({ ok: true })),
      history: vi.fn(async () => ({ messages: [] })),
      canvases: {
        create: vi.fn(async ({ title }: { title?: string }) => ({ canvas_id: title === "Cc Sessions" ? "CANVAS-SESSIONS" : "CANVAS-COST" })),
      },
    },
    chat: {
      postMessage: vi.fn(async (_args: Record<string, unknown>) => ({ ts: `${Date.now()}.1` })),
      update: vi.fn(async (_args: Record<string, unknown>) => ({ ok: true })),
      delete: vi.fn(async (_args: Record<string, unknown>) => ({ ok: true })),
      postEphemeral: vi.fn(async (_args: Record<string, unknown>) => ({ ok: true })),
    },
    canvases: { edit: vi.fn(async () => ({ ok: true })) },
    users: { info: vi.fn(async ({ user }: { user: string }) => ({ user: { name: user } })) },
    views: {
      update: vi.fn(async () => ({ ok: true })),
      open: vi.fn(async () => ({ ok: true })),
    },
    functions: {
      completeSuccess: vi.fn(async () => ({ ok: true })),
      completeError: vi.fn(async () => ({ ok: true })),
    },
  };
}

function makeReadModel(): ChatReadModel {
  return {
    getChatMessage: () => null,
    getWorkflowTarget: () => null,
    getLatestWorkflowTargetForSession: () => null,
    getLatestWorkflowTargetForChannel: () => null,
    getSessionRelayState: (sessionId) => ({
      sessionId,
      provider: "codex-cli",
      repoPath: "E:/repo",
      activeRepos: [],
      branch: "feat/test",
      status: "active",
      currentTask: "Slack channel routing",
      roleLabel: "実装",
      delegationEmoji: null,
      delegationRunId: null,
      delegationParentSessionId: null,
      model: "gpt",
      subsidiaryId: null,
      endedAt: null,
      effortLevel: null,
      fastMode: null,
    }),
    getSessionCardState: (sessionId, status, poem) => ({
      who: "実装 / 雑用係",
      emoji: null,
      provider: "codex-cli",
      model: "gpt",
      effortLevel: "high",
      currentTask: "Slack channel routing",
      shortId: sessionId.slice(0, 8),
      status,
      poem: poem ?? null,
    }),
    getEndedSessionPoem: () => "done",
    listSlackSessionIndex: () => [],
    getSessionStatusSnapshot: async () => null,
    getSessionPromptEvent: () => null,
    getSessionTitleEvent: () => null,
    getMonitorSnapshot: async () => ({ generatedAt: 0, activeCount: 0, orgCostLines: [], channelCostLines: [] }),
    getPrQueueSnapshot: () => ({ content: "" }),
    getCostSnapshot: async () => ({ markdown: "# Cost", codexRate: { used5h: null, reset5hAt: null }, claudeUsage: null }),
    isSessionActive: () => true,
    isCodexSession: () => false,
  };
}

async function startHarness(archiveDelayMin = 30, reactionWorkflowEnabled = false) {
  const db = makeTestDb();
  const web = makeWeb();
  const socket = makeSocket();
  const platform = await startSlackBot({
    db,
    readModel: makeReadModel(),
    slackConfigRepo: makeSlackConfigRepo(db),
    concordiaUrl: "http://concordia.test",
    env: {
      enabled: true,
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelId: "HUB",
      archiveDelayMin,
      archiveDelayInvalid: false,
    },
    runHeadless: async () => ({ ok: true, stdout: "ok", exit_code: 0, stderr: "", duration_ms: 1 }),
    reactionWorkflowEnabled,
    customWorkflowsPath,
    isReactionWorkflowUserAllowed: () => reactionWorkflowEnabled,
    webClient: web as unknown as WebClient,
    socketClient: socket as unknown as SocketModeClient,
  });
  if (!platform) throw new Error("Slack platform did not start");
  return { platform, web, socket, db };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack bot session-per-channel", () => {
  it("posts session egress at channel top level without thread_ts", async () => {
    const { platform, web } = await startHarness();
    await platform.ensureSessionSurface("session-1");
    await platform.postToSession({ sessionId: "session-1", text: "relay", authorLabel: "Agent" });

    const relay = web.chat.postMessage.mock.calls
      .map(([args]) => args as Record<string, unknown>)
      .find((args) => args.text === "relay");
    expect(relay).toMatchObject({ channel: "C1", text: "relay" });
    expect(relay).not.toHaveProperty("thread_ts");
    expect(web.conversations.create).toHaveBeenCalledWith(expect.objectContaining({ is_private: false }));
    await platform.stop();
    const createCount = web.conversations.create.mock.calls.length;
    eventBus.emit({ type: "session.started", session_id: "after-stop", provider: "codex-cli", repo_path: "E:/repo", branch: null, ts: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(web.conversations.create).toHaveBeenCalledTimes(createCount);
  });

  it("routes mapped and Hub top-level messages while ignoring thread replies", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { platform, socket } = await startHarness();
    await platform.ensureSessionSurface("session-1");
    const message = socket.handlers.get("message");
    if (!message) throw new Error("message handler missing");
    const ack = vi.fn(async () => {});

    await message({ event: { type: "message", channel: "C1", user: "U1", ts: "1", text: "inject" }, ack } as never);
    await message({ event: { type: "message", channel: "HUB", user: "U1", ts: "2", text: "consult" }, ack } as never);
    await message({ event: { type: "message", channel: "C1", user: "U1", ts: "3", thread_ts: "1", text: "ignored" }, ack } as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/sessions/session-1/inject");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/v1/chat");
    await platform.stop();
  });

  it("starts standalone emoji workflows only in dedicated session channels", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { platform, web, socket } = await startHarness(30, true);
    await platform.ensureSessionSurface("session-1");
    web.chat.postMessage.mockClear();
    const message = socket.handlers.get("message");
    if (!message) throw new Error("message handler missing");
    const ack = vi.fn(async () => {});

    await message({ event: { type: "message", channel: "C1", user: "U1", ts: "1", text: "🙏" }, ack } as never);
    await vi.waitFor(() => expect(web.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      text: expect.stringContaining("受け付けました"),
    })));

    web.chat.postMessage.mockClear();
    await message({ event: { type: "message", channel: "HUB", user: "U1", ts: "2", text: "🙏" }, ack } as never);
    expect(web.chat.postMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await platform.stop();
  });

  it("preserves Slack provenance on an active-session inject workflow", async () => {
    const { platform, socket } = await startHarness(30, true);
    await platform.ensureSessionSurface("session-1");
    const message = socket.handlers.get("message");
    if (!message) throw new Error("message handler missing");
    const captured: Array<Record<string, unknown>> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (
        event.type === "session.inject" &&
        event.target_session_id === "session-1" &&
        event.source === "reaction-workflow" &&
        event.provenance?.platform === "slack"
      ) {
        captured.push(event as unknown as Record<string, unknown>);
      }
    });
    try {
      await message({
        event: { type: "message", channel: "C1", user: "U1", ts: "1", text: "👍" },
        ack: vi.fn(async () => {}),
      } as never);
      await vi.waitFor(() => expect(captured).toHaveLength(1));
      expect(captured[0]).toMatchObject({
        source: "reaction-workflow",
        provenance: {
          kind: "reaction-workflow",
          action: "start-impl",
          platform: "slack",
          emoji: "👍",
          sourceMessageId: "C1:1",
          actorId: "U1",
        },
      });
    } finally {
      unsubscribe();
      await platform.stop();
    }
  });

  it("starts reaction workflows only in dedicated session channels", async () => {
    const { platform, web, socket } = await startHarness(30, true);
    await platform.ensureSessionSurface("session-1");
    web.chat.postMessage.mockClear();
    const reactionAdded = socket.handlers.get("reaction_added");
    if (!reactionAdded) throw new Error("reaction_added handler missing");
    const ack = vi.fn(async () => {});

    await reactionAdded({
      event: { user: "U1", reaction: "memo", item: { type: "message", channel: "C1", ts: "1" } },
      ack,
    } as never);
    await vi.waitFor(() => expect(web.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      text: expect.stringContaining("受け付けました"),
    })));

    web.chat.postMessage.mockClear();
    await reactionAdded({
      event: { user: "U1", reaction: "memo", item: { type: "message", channel: "HUB", ts: "2" } },
      ack,
    } as never);
    expect(web.chat.postMessage).not.toHaveBeenCalled();
    await platform.stop();
  });

  it("resolves question actions by channel mapping and archives ended sessions", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { platform, web, socket } = await startHarness(0);
    await platform.ensureSessionSurface("session-1");
    await platform.postQuestion({ target_session_id: "session-1", question_id: 9, question: "Proceed?", options: ["Yes"] });
    const interactive = socket.handlers.get("interactive");
    if (!interactive) throw new Error("interactive handler missing");

    await interactive({
      body: {
        type: "block_actions",
        channel: { id: "C1" },
        message: { ts: "question-ts" },
        actions: [{ action_id: "cc_answer:9:0" }],
      },
      ack: vi.fn(async () => {}),
    } as never);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/v1/sessions/session-1/answer-question");

    eventBus.emit({ type: "session.ended", session_id: "session-1", ts: 100 });
    await vi.waitFor(() => expect(web.conversations.archive).toHaveBeenCalledWith({ channel: "C1" }));
    await platform.stop();
  });

  it("cancels the pending archive when a session resumes before it fires (session.started after session.ended)", async () => {
    // 継続レビュー指摘 (slack/bot.ts:457): archive 予約後にセッションが再開したら
    // 予約を取り消さないと、 まだ活動中のチャンネルが sweep で誤って archive される。
    // archiveDelayMin>0 (既定30分) で schedule() が即時 sweep しないようにし、
    // その間に resume (session.started) が来たケースを再現する。
    const { platform, web, socket, db } = await startHarness();
    const { makeSlackSessionChannelsRepo } = await import("./session-channels-repo.js");
    const channels = makeSlackSessionChannelsRepo(db);
    await platform.ensureSessionSurface("session-1");
    void socket; // ハンドラは使わないが harness の型を揃えるため参照だけ保持

    eventBus.emit({ type: "session.ended", session_id: "session-1", ts: 100 });
    await vi.waitFor(() => expect(channels.findBySessionId("session-1")?.archive_due_at).not.toBeNull());

    eventBus.emit({ type: "session.started", session_id: "session-1", provider: "codex-cli", repo_path: "E:/repo", branch: null, ts: 101 });
    await vi.waitFor(() => expect(channels.findBySessionId("session-1")?.archive_due_at).toBeNull());

    expect(web.conversations.archive).not.toHaveBeenCalled();
    await platform.stop();
  });
});
