/** @implements spec/feature/staff-roster.md §3 — one-time spawn approval invariants */
import { describe, expect, it, vi } from "vitest";
import {
  consumeApprovedSpawn,
  pruneSpawnApprovals,
  requestSpawnApproval,
  type SpawnApprovalStore,
} from "./spawn-approval.js";

function spawnInteraction(userId: string, value = "codex") {
  return {
    user: { id: userId },
    guildId: "guild-1",
    channelId: "channel-1",
    options: { data: [{ name: "agent", type: 3, value }] },
  };
}

describe("spawn approval", () => {
  it("consumes an approval once for the exact requester and command", () => {
    const store: SpawnApprovalStore = new Map([["token", {
      requesterUserId: "requester",
      guildId: "guild-1",
      channelId: "channel-1",
      commandSignature: '[{"name":"agent","type":3,"value":"codex","options":[]}]',
      status: "approved",
      createdAt: Date.now(),
    }]]);

    expect(consumeApprovedSpawn(spawnInteraction("other") as never, store)).toBe(false);
    expect(consumeApprovedSpawn(spawnInteraction("requester", "claude") as never, store)).toBe(false);
    expect(consumeApprovedSpawn(spawnInteraction("requester") as never, store)).toBe(true);
    expect(consumeApprovedSpawn(spawnInteraction("requester") as never, store)).toBe(false);
  });

  it("prunes expired requests", () => {
    const store: SpawnApprovalStore = new Map([["expired", {
      requesterUserId: "requester",
      guildId: "guild-1",
      channelId: "channel-1",
      commandSignature: "[]",
      status: "pending",
      createdAt: 0,
    }]]);

    pruneSpawnApprovals(store, 16 * 60 * 1000);
    expect(store.size).toBe(0);
  });

  it("mentions only unique, valid Discord executive IDs", async () => {
    const reply = vi.fn(async (_payload: unknown) => undefined);
    const store: SpawnApprovalStore = new Map();
    await requestSpawnApproval({
      ...spawnInteraction("111111111111111111"),
      reply,
    } as never, {
      spawnApprovals: store,
      listExecutiveDiscordUserIds: () => [
        "222222222222222222",
        "not-a-discord-id",
        " 222222222222222222 ",
      ],
    } as never);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: {
        users: ["222222222222222222", "111111111111111111"],
      },
    }));
    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).not.toContain("not-a-discord-id");
    expect(store.size).toBe(1);
  });

  it("removes an approval request when its Discord message cannot be created", async () => {
    const store: SpawnApprovalStore = new Map();
    const failure = new Error("interaction expired");
    await expect(requestSpawnApproval({
      ...spawnInteraction("111111111111111111"),
      reply: vi.fn(async (_payload: unknown) => { throw failure; }),
    } as never, {
      spawnApprovals: store,
      listExecutiveDiscordUserIds: () => ["222222222222222222"],
    } as never)).rejects.toBe(failure);

    expect(store.size).toBe(0);
  });
});
