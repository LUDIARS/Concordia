import { ChannelType, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { createTaskWorkflowOrphanReconciler } from "./taskworkflow-orphan-reconcile.js";

function fixture(count = 1) {
  const now = 10_000_000;
  const threads = Array.from({ length: count }, (_, i) => {
    const id = String(i + 1).padStart(3, "0");
    const thread = {
      id, type: ChannelType.PublicThread, parentId: "forum", archived: false, createdTimestamp: 1,
      fetchStarterMessage: vi.fn(async () => ({
        id, webhookId: "cc-hook", author: { id: "cc-hook" },
        content: '**TaskWorkflow** `child`\n**Delegation run** `run`\n**Repo** `Concordia`',
      })),
      setArchived: vi.fn(async (_value: boolean, _reason: string) => { thread.archived = true; }),
    };
    return thread;
  });
  const forum = {
    id: "forum", type: ChannelType.GuildForum,
    fetchWebhooks: vi.fn(async () => new Map([["cc-hook", { id: "cc-hook", owner: { id: "cc-bot" } }]])),
  };
  const bindings = {
    findByChannelId: vi.fn((_id: string): ReturnType<DiscordSessionChannelsRepo["findByChannelId"]> => null),
    findBySessionId: vi.fn((_id: string): ReturnType<DiscordSessionChannelsRepo["findBySessionId"]> => null),
  };
  const findSession = vi.fn((): { status: string } | null => null);
  const run = { child_session_id: "child", status: "running" };
  const findRun = vi.fn(() => run);
  const dryRun = vi.fn(() => false);
  const log = { info: vi.fn(), warn: vi.fn() };
  const guild = { client: { user: { id: "cc-bot" } }, channels: {
    fetch: vi.fn(async () => forum),
    fetchActiveThreads: vi.fn(async () => ({ threads: new Map(threads.map((t) => [t.id, t])) })),
  } };
  const reconcile = createTaskWorkflowOrphanReconciler({ guild: guild as unknown as Guild, forumId: "forum", bindings, findSession, findRun, log, dryRun, now: () => now });
  return { reconcile, threads, forum, bindings, findSession, findRun, run, dryRun, log, guild, now };
}

describe("TaskWorkflow reverse reconciliation", () => {
  it("archives the missing-session/missing-binding case once without changing run outcome", async () => {
    const f = fixture();
    await f.reconcile();
    await f.reconcile();
    expect(f.threads[0].setArchived).toHaveBeenCalledTimes(1);
    expect(f.run.status).toBe("running");
  });

  it("keeps live sessions and bindings appearing while Discord is awaited", async () => {
    const f = fixture();
    f.threads[0].fetchStarterMessage.mockImplementationOnce(async () => {
      f.findSession.mockReturnValue({ status: "active" });
      return { id: "001", webhookId: "cc-hook", author: { id: "cc-hook" }, content: '**TaskWorkflow** `child`\n**Delegation run** `run`\n**Repo** `Cc`' };
    });
    await f.reconcile();
    expect(f.threads[0].setArchived).not.toHaveBeenCalled();
    f.findSession.mockReturnValue(null);
    f.bindings.findBySessionId.mockReturnValue({ channel_id: "replacement" } as ReturnType<DiscordSessionChannelsRepo["findBySessionId"]>);
    await f.reconcile();
    expect(f.threads[0].setArchived).not.toHaveBeenCalled();
  });

  it("does not scan recent, foreign or already bound threads", async () => {
    const f = fixture(3);
    f.threads[0].createdTimestamp = f.now;
    f.threads[1].parentId = "other-forum";
    f.bindings.findByChannelId.mockImplementation((id: string) => id === "003" ? { channel_id: id } as NonNullable<ReturnType<DiscordSessionChannelsRepo["findByChannelId"]>> : null);
    await f.reconcile();
    for (const thread of f.threads) expect(thread.fetchStarterMessage).not.toHaveBeenCalled();
  });

  it("does not trust a foreign webhook even when its starter text matches", async () => {
    const f = fixture();
    f.forum.fetchWebhooks.mockResolvedValue(new Map([["cc-hook", { id: "cc-hook", owner: { id: "another-bot" } }]]));
    await f.reconcile();
    expect(f.threads[0].setArchived).not.toHaveBeenCalled();
  });

  it("keeps dry-run candidates visible", async () => {
    const f = fixture(); f.dryRun.mockReturnValue(true);
    await f.reconcile();
    expect(f.threads[0].setArchived).not.toHaveBeenCalled();
    expect(f.log.info).toHaveBeenCalledWith(expect.stringContaining("dry-run"));
  });

  it("read failures never become missing sessions and one failure does not block others", async () => {
    const f = fixture(2);
    f.findSession.mockImplementationOnce(() => { throw new Error("read unavailable"); });
    await f.reconcile();
    expect(f.threads[0].setArchived).not.toHaveBeenCalled();
    expect(f.threads[1].setArchived).toHaveBeenCalledTimes(1);
    expect(f.log.warn).toHaveBeenCalled();
  });

  it("retries an archive failure on a later pass", async () => {
    const f = fixture();
    f.threads[0].setArchived.mockRejectedValueOnce(new Error("Discord unavailable"));
    await f.reconcile(); await f.reconcile();
    expect(f.threads[0].setArchived).toHaveBeenCalledTimes(2);
    expect(f.threads[0].archived).toBe(true);
  });

  it("bounds each pass and rotates past uncertain candidates without concurrent duplicate work", async () => {
    const f = fixture(26);
    f.findSession.mockReturnValue({ status: "active" });
    await Promise.all([f.reconcile(), f.reconcile()]);
    expect(f.findSession).toHaveBeenCalledTimes(25);
    expect(f.threads[25].fetchStarterMessage).not.toHaveBeenCalled();
    await f.reconcile();
    expect(f.threads[25].fetchStarterMessage).toHaveBeenCalledTimes(1);
  });
});
