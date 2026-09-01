import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, Interaction } from "discord.js";
import {
  dispatchForumSpawnApprovalInteraction,
  isForumSpawnApprovalInteraction,
  pruneForumSpawnApprovals,
  requestForumSpawnApproval,
  type ForumSpawnApprovalStore,
} from "./forum-spawn-approval.js";

const APPROVED_CONTENT = {
  title: "Implement Phase 2",
  body: "Build spawn-by-post",
  tagState: { appliedTags: [], availableTags: [] },
};
const THREAD = {
  id: "thread-1",
  guildId: "guild-1",
  ownerId: "requester-1",
  approvedContent: APPROVED_CONTENT,
};

function makeButton(patch: {
  customId: string;
  userId?: string;
  guildId?: string;
  channelId?: string;
}): ButtonInteraction {
  return {
    isButton: () => true,
    customId: patch.customId,
    guildId: patch.guildId ?? "guild-1",
    channelId: patch.channelId ?? "thread-1",
    user: { id: patch.userId ?? "manager-1" },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ButtonInteraction;
}

async function requested(store: ForumSpawnApprovalStore): Promise<string> {
  const postCard = vi.fn(async () => undefined);
  await requestForumSpawnApproval({ store, postCard }, THREAD);
  expect(postCard).toHaveBeenCalledTimes(1);
  const token = [...store.keys()][0]!;
  return token;
}

describe("forum spawn approval", () => {
  it("posts one card per thread and dedupes pending requests", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const postCard = vi.fn(async () => undefined);
    await requestForumSpawnApproval({ store, postCard }, THREAD);
    await requestForumSpawnApproval({ store, postCard }, THREAD);
    expect(postCard).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("drops the pending entry when the card cannot be posted", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const postCard = vi.fn(async () => { throw new Error("no channel"); });
    await expect(requestForumSpawnApproval({ store, postCard }, THREAD)).rejects.toThrow("no channel");
    expect(store.size).toBe(0);
  });

  it("allow by a manager executes the spawn and consumes the request", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const token = await requested(store);
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const interaction = makeButton({ customId: `forum-spawn-approval:allow:${token}` });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store,
      isApproverAllowed: (userId) => userId === "manager-1",
      executeSpawn,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).toHaveBeenCalledWith("thread-1", APPROVED_CONTENT);
    expect(store.size).toBe(0);
    expect((interaction as unknown as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalled();
  });

  it("reports a changed approval target instead of leaving a false success card", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const token = await requested(store);
    const interaction = makeButton({ customId: `forum-spawn-approval:allow:${token}` });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store,
      isApproverAllowed: () => true,
      executeSpawn: vi.fn(async () => ({ ok: false as const, error: "content changed" })),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect((interaction as unknown as { editReply: ReturnType<typeof vi.fn> }).editReply)
      .toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("変更") }));
  });

  it("rejects a presser without the session_spawn capability", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const token = await requested(store);
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const interaction = makeButton({ customId: `forum-spawn-approval:allow:${token}`, userId: "staff-1" });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store,
      isApproverAllowed: () => false,
      executeSpawn,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it("rejects self-approval by the requester even if privileged", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const token = await requested(store);
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const interaction = makeButton({ customId: `forum-spawn-approval:allow:${token}`, userId: "requester-1" });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store,
      isApproverAllowed: () => true,
      executeSpawn,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).not.toHaveBeenCalled();
  });

  it("deny removes the request without spawning", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const token = await requested(store);
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const interaction = makeButton({ customId: `forum-spawn-approval:deny:${token}` });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store,
      isApproverAllowed: () => true,
      executeSpawn,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("expires stale requests", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const token = await requested(store);
    pruneForumSpawnApprovals(store, Date.now() + 61 * 60 * 1000);
    expect(store.size).toBe(0);
    const interaction = makeButton({ customId: `forum-spawn-approval:allow:${token}` });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store,
      isApproverAllowed: () => true,
      executeSpawn: vi.fn(async () => ({ ok: true as const })),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect((interaction as unknown as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalled();
  });

  it("identifies its own button interactions", () => {
    expect(isForumSpawnApprovalInteraction(makeButton({ customId: "forum-spawn-approval:allow:x" }) as Interaction)).toBe(true);
    expect(isForumSpawnApprovalInteraction(makeButton({ customId: "spawn-approval:allow:x" }) as Interaction)).toBe(false);
  });
});
