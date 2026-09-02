import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, Interaction } from "discord.js";
import {
  dispatchForumSpawnApprovalInteraction,
  forumSpawnApprovalFingerprint,
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
    message: { createdTimestamp: Date.now(), author: { id: "bot-1" } },
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
    const postedArgs = postCard.mock.calls[0] as unknown as unknown[];
    expect(JSON.stringify(postedArgs[2])).toContain(
      forumSpawnApprovalFingerprint(APPROVED_CONTENT),
    );
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
      approvalCardAuthorId: "bot-1",
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
      approvalCardAuthorId: "bot-1",
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
      approvalCardAuthorId: "bot-1",
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
      approvalCardAuthorId: "bot-1",
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).not.toHaveBeenCalled();
  });

  it("rejects a copied valid token on a card posted by another Bot", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const token = await requested(store);
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const interaction = makeButton({ customId: `forum-spawn-approval:allow:${token}` });
    (interaction as unknown as { message: { author: { id: string } } }).message.author.id = "other-bot";
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store,
      isApproverAllowed: () => true,
      executeSpawn,
      approvalCardAuthorId: "bot-1",
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
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
      approvalCardAuthorId: "bot-1",
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
      approvalCardAuthorId: "bot-1",
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect((interaction as unknown as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalled();
  });

  it("identifies its own button interactions", () => {
    expect(isForumSpawnApprovalInteraction(makeButton({ customId: "forum-spawn-approval:allow:x" }) as Interaction)).toBe(true);
    expect(isForumSpawnApprovalInteraction(makeButton({ customId: "spawn-approval:allow:x" }) as Interaction)).toBe(false);
  });
});

describe("forum spawn approval recovery (2026-09-02 neco 報告)", () => {
  // Cc 再起動で in-memory pending が消えた承認カードでも、カード作成から TTL 内の
  // 承認者押下ならカード作成時と同じスレッド内容を復元して起動する。

  function makeRecoverButton(patch: {
    userId?: string;
    createdTimestamp?: number | null;
    authorId?: string;
    contentFingerprint?: string;
  }) {
    const fingerprint = patch.contentFingerprint ?? forumSpawnApprovalFingerprint(APPROVED_CONTENT);
    const base = makeButton({
      customId: `forum-spawn-approval:allow:lost-token:${fingerprint}`,
      userId: patch.userId,
    });
    (base as unknown as { message?: { createdTimestamp?: number; author?: { id: string } } }).message =
      patch.createdTimestamp === null
        ? undefined
        : { createdTimestamp: patch.createdTimestamp ?? Date.now(), author: { id: patch.authorId ?? "bot-1" } };
    return base;
  }

  it("store 消失後でもカードが TTL 内なら復元して起動する", async () => {
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const recoverApproval = vi.fn(async () => ({
      requesterUserId: "requester-1",
      approvedContent: APPROVED_CONTENT,
    }));
    const interaction = makeRecoverButton({});
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store: new Map(),
      isApproverAllowed: () => true,
      executeSpawn,
      approvalCardAuthorId: "bot-1",
      recoverApproval,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(recoverApproval).toHaveBeenCalledWith("thread-1");
    expect(executeSpawn).toHaveBeenCalledWith("thread-1", APPROVED_CONTENT);
  });

  it("復元経路でも申請者本人の自己承認は拒否する", async () => {
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const interaction = makeRecoverButton({ userId: "requester-1" });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store: new Map(),
      isApproverAllowed: () => true,
      executeSpawn,
      approvalCardAuthorId: "bot-1",
      recoverApproval: vi.fn(async () => ({
        requesterUserId: "requester-1",
        approvedContent: APPROVED_CONTENT,
      })),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).not.toHaveBeenCalled();
  });

  it("カードが TTL を過ぎている場合は復元しない", async () => {
    const recoverApproval = vi.fn(async () => ({
      requesterUserId: "requester-1",
      approvedContent: APPROVED_CONTENT,
    }));
    const interaction = makeRecoverButton({ createdTimestamp: Date.now() - 2 * 60 * 60 * 1000 });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store: new Map(),
      isApproverAllowed: () => true,
      executeSpawn: vi.fn(async () => ({ ok: true as const })),
      approvalCardAuthorId: "bot-1",
      recoverApproval,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(recoverApproval).not.toHaveBeenCalled();
    expect((interaction as unknown as { reply: ReturnType<typeof vi.fn> }).reply)
      .toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("失効") }));
  });

  it("復元不可 (スレッド消失等) は従来どおり失効を返す", async () => {
    const interaction = makeRecoverButton({});
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store: new Map(),
      isApproverAllowed: () => true,
      executeSpawn: vi.fn(async () => ({ ok: true as const })),
      approvalCardAuthorId: "bot-1",
      recoverApproval: vi.fn(async () => null),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect((interaction as unknown as { reply: ReturnType<typeof vi.fn> }).reply)
      .toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("失効") }));
  });

  it("別 Bot が投稿した同形式のカードは復元しない", async () => {
    const recoverApproval = vi.fn(async () => ({
      requesterUserId: "requester-1",
      approvedContent: APPROVED_CONTENT,
    }));
    const interaction = makeRecoverButton({ authorId: "other-bot" });
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store: new Map(),
      isApproverAllowed: () => true,
      executeSpawn: vi.fn(async () => ({ ok: true as const })),
      approvalCardAuthorId: "bot-1",
      recoverApproval,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(recoverApproval).not.toHaveBeenCalled();
  });

  it("カード作成後に承認対象が変わっていたら復元しない", async () => {
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const interaction = makeRecoverButton({});
    await dispatchForumSpawnApprovalInteraction(interaction as Interaction, {
      store: new Map(),
      isApproverAllowed: () => true,
      executeSpawn,
      approvalCardAuthorId: "bot-1",
      recoverApproval: vi.fn(async () => ({
        requesterUserId: "requester-1",
        approvedContent: { ...APPROVED_CONTENT, body: "changed after request" },
      })),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(executeSpawn).not.toHaveBeenCalled();
  });

  it("同じ復元カードは一度しか実行しない", async () => {
    const store: ForumSpawnApprovalStore = new Map();
    const executeSpawn = vi.fn(async () => ({ ok: true as const }));
    const recoverApproval = vi.fn(async () => ({
      requesterUserId: "requester-1",
      approvedContent: APPROVED_CONTENT,
    }));
    const deps = {
      store,
      isApproverAllowed: () => true,
      executeSpawn,
      approvalCardAuthorId: "bot-1",
      recoverApproval,
      log: { info: vi.fn(), warn: vi.fn() },
    };
    await dispatchForumSpawnApprovalInteraction(makeRecoverButton({}) as Interaction, deps);
    await dispatchForumSpawnApprovalInteraction(makeRecoverButton({}) as Interaction, deps);
    expect(executeSpawn).toHaveBeenCalledTimes(1);
  });
});
