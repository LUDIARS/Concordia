import { ChannelType, type Message } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";

type SpawnResult = { ok: true; pid: number | null } | { ok: false; error: string };

const requestTestSpawn = vi.fn(
  async (..._args: unknown[]): Promise<SpawnResult> => ({ ok: true, pid: 42 }),
);
// spawn は特権 HTTP なので、 判定ロジックだけを見るために起動要求は差し替える。
vi.mock("./test-forum-actions.js", () => ({
  requestTestSpawn: (...args: unknown[]) => requestTestSpawn(...args),
}));

const { handleTestForumMessage } = await import("./test-forum-message.js");

function surfaceRow(overrides: Partial<DiscordTestSurfaceRow> = {}): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: "sha-1",
    repo_root_path: "E:/Document/Ars/Concordia",
    head_branch: "feat/forum",
    worktree_path: null,
    thread_id: "thread-42",
    status: "open",
    created_at: 1,
    closed_at: null,
    close_reason: null,
    content_hash: null,
    qa_run_id: null,
    run_state: "candidate",
    provider: "codex",
    model: "sol",
    effort: "xhigh",
    session_id: null,
    local_pr_id: null,
    controls_message_id: null,
    check_status: "test_ok",
    ...overrides,
  };
}

function message(overrides: {
  bot?: boolean;
  webhookId?: string | null;
  channelType?: number;
  parentId?: string | null;
  content?: string;
} = {}) {
  const react = vi.fn(async (_emoji: string) => undefined);
  const msg = {
    id: "msg-1",
    channelId: "thread-42",
    content: overrides.content ?? "この PR を確認して",
    author: { id: "user-1", bot: overrides.bot ?? false },
    webhookId: overrides.webhookId ?? null,
    channel: {
      id: "thread-42",
      type: overrides.channelType ?? ChannelType.PublicThread,
      parentId: overrides.parentId === undefined ? "forum-1" : overrides.parentId,
    },
    react,
  } as unknown as Message;
  return { msg, react };
}

function deps(overrides: Partial<Parameters<typeof handleTestForumMessage>[1]> = {}, rows = [surfaceRow()]) {
  return {
    testForumId: "forum-1",
    surfaces: { listOpen: () => rows } as unknown as DiscordTestSurfacesRepo,
    concordiaUrl: "http://127.0.0.1:17330",
    workspaceRoots: ["E:/Document/Ars"],
    isLaunchUserAllowed: () => true,
    isSessionAlive: () => false,
    injectToSession: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  requestTestSpawn.mockClear();
  requestTestSpawn.mockResolvedValue({ ok: true, pid: 42 });
});

describe("handleTestForumMessage", () => {
  it("declines messages that belong to the normal ingress path", async () => {
    // Bot / webhook / 他チャンネル / 掲載外スレッドは通常の ingress に委ねる。
    await expect(handleTestForumMessage(message({ bot: true }).msg, deps())).resolves.toBe(false);
    await expect(handleTestForumMessage(message({ webhookId: "wh-1" }).msg, deps())).resolves.toBe(false);
    await expect(handleTestForumMessage(message({ channelType: ChannelType.GuildText }).msg, deps()))
      .resolves.toBe(false);
    await expect(handleTestForumMessage(message({ parentId: "other-forum" }).msg, deps())).resolves.toBe(false);
    await expect(handleTestForumMessage(message().msg, deps({}, []))).resolves.toBe(false);
    expect(requestTestSpawn).not.toHaveBeenCalled();
  });

  it("injects into the live test session instead of spawning a second one", async () => {
    const injectToSession = vi.fn();
    const { msg, react } = message();
    const handled = await handleTestForumMessage(msg, deps({
      injectToSession,
      isSessionAlive: (id: string) => id === "session-1",
    }, [surfaceRow({ session_id: "session-1", run_state: "testing" })]));

    expect(handled).toBe(true);
    expect(injectToSession).toHaveBeenCalledWith("session-1", "この PR を確認して", "discord:user-1:thread-42:msg-1");
    expect(requestTestSpawn).not.toHaveBeenCalled();
    expect(react).toHaveBeenCalledWith("📨");
  });

  it("spawns a test session with the post as the instruction", async () => {
    const { msg, react } = message();
    const d = deps();
    expect(await handleTestForumMessage(msg, d)).toBe(true);
    expect(requestTestSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      d,
      "この PR を確認して",
    );
    expect(react).toHaveBeenCalledWith("🧪");
  });

  it("refuses to spawn for users without the launch capability, and fails closed when unwired", async () => {
    const denied = message();
    expect(await handleTestForumMessage(denied.msg, deps({ isLaunchUserAllowed: () => false }))).toBe(true);
    expect(denied.react).toHaveBeenCalledWith("🚫");

    const unwired = message();
    expect(await handleTestForumMessage(unwired.msg, deps({ isLaunchUserAllowed: undefined }))).toBe(true);
    expect(unwired.react).toHaveBeenCalledWith("🚫");
    expect(requestTestSpawn).not.toHaveBeenCalled();
  });

  it("warns instead of spawning when the surface is no longer a candidate", async () => {
    const { msg, react } = message();
    const handled = await handleTestForumMessage(
      msg,
      deps({}, [surfaceRow({ run_state: "testing", session_id: "dead-session" })]),
    );
    expect(handled).toBe(true);
    expect(requestTestSpawn).not.toHaveBeenCalled();
    expect(react).toHaveBeenCalledWith("⚠️");
  });

  it("reports a failed spawn on the post itself", async () => {
    requestTestSpawn.mockResolvedValue({ ok: false, error: "spawn refused" });
    const { msg, react } = message();
    const warn = vi.fn();
    expect(await handleTestForumMessage(msg, deps({ log: { info: vi.fn(), warn } }))).toBe(true);
    expect(react).toHaveBeenCalledWith("⚠️");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn refused"));
  });

  it("swallows an empty post without spawning", async () => {
    const { msg, react } = message({ content: "   " });
    expect(await handleTestForumMessage(msg, deps())).toBe(true);
    expect(requestTestSpawn).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });
});
