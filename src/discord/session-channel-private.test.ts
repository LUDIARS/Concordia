/**
 * プライベート相談のチャンネルの終了処理 (spec/feature/tech-consultation.md §4 SPEC-CONSULT-CLOSE)。
 * archive カテゴリへ移すとカテゴリの権限に同期して閉じた overwrite が外れるため、 移さず書き込みだけ止める。
 */
import { ChannelType, OverwriteType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { onSessionStatusChanged, onSessionWorkState, reconcileEndedSessionChannels } from "./session-channel.js";

function setup(parentId: string) {
  const rows = new Map<string, Record<string, unknown>>([["sess-1", {
    session_id: "sess-1",
    channel_id: "chan-1",
    channel_kind: "channel",
    status: "active",
    display_state: "active",
    agent_type: "claude",
    name_body: "相談",
    delegation_emoji: null,
    webhook_id: "wh-1",
    webhook_token: "tok",
  }]]);
  const repo = {
    findBySessionId: vi.fn((id: string) => rows.get(id) ?? null),
    listAll: vi.fn(() => [...rows.values()]),
    setStatus: vi.fn((id: string, status: string) => { rows.get(id)!.status = status; }),
    setDisplayState: vi.fn((id: string, state: string) => { rows.get(id)!.display_state = state; }),
    clearWebhook: vi.fn((id: string) => { rows.get(id)!.webhook_id = null; rows.get(id)!.webhook_token = null; }),
    tryClaimRename: vi.fn(() => true),
  };
  const overwriteEdit = vi.fn(async () => undefined);
  const channel = {
    id: "chan-1",
    name: "相談-20260930-abc123",
    type: ChannelType.GuildText,
    parentId,
    guild: { client: { user: { id: "bot-1" } } },
    edit: vi.fn(async () => undefined),
    permissionOverwrites: {
      edit: overwriteEdit,
      cache: new Map([
        ["everyone-role", { id: "everyone-role", type: OverwriteType.Role }],
        ["111", { id: "111", type: OverwriteType.Member }],
        ["bot-1", { id: "bot-1", type: OverwriteType.Member }],
      ]),
    },
  };
  const guild = {
    channels: { cache: new Map([["chan-1", channel]]), fetch: vi.fn(async () => channel) },
  };
  const webhooks = { purgeChannel: vi.fn(async () => 1), releaseSession: vi.fn() };
  const deps = {
    guild: guild as never,
    layout: { archiveCategoryId: "archive-cat", privateCategoryId: "consult-cat" } as never,
    repo: repo as never,
    webhooks: webhooks as never,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return { deps, rows, channel, overwriteEdit, webhooks };
}

describe("private consultation channels on session end", () => {
  it("locks writing instead of moving the channel to the archive category", async () => {
    const { deps, rows, channel, overwriteEdit, webhooks } = setup("consult-cat");
    await onSessionStatusChanged(deps, { sessionId: "sess-1", status: "ended" });
    expect(channel.edit).not.toHaveBeenCalled();
    expect(overwriteEdit).toHaveBeenCalledWith("111", { SendMessages: false, AttachFiles: false }, expect.anything());
    expect(webhooks.purgeChannel).toHaveBeenCalledWith("chan-1");
    expect(rows.get("sess-1")).toMatchObject({ status: "ended", display_state: "ended", webhook_id: null });
  });

  it("does not keep reconciling a closed private channel", async () => {
    const { deps, channel } = setup("consult-cat");
    await onSessionStatusChanged(deps, { sessionId: "sess-1", status: "ended" });
    const result = await reconcileEndedSessionChannels({ ...deps, isSessionEnded: () => true });
    expect(result.reconciled).toBe(0);
    expect(channel.edit).not.toHaveBeenCalled();
  });

  it("keeps the neutral name on work-state changes", async () => {
    const { deps, rows, channel } = setup("consult-cat");
    await onSessionWorkState(deps, { sessionId: "sess-1", working: true });
    expect(channel.edit).not.toHaveBeenCalled();
    expect(rows.get("sess-1")?.display_state).toBe("working");
  });

  it("still archives ordinary session channels", async () => {
    const { deps, channel } = setup("sessions-cat");
    await onSessionStatusChanged(deps, { sessionId: "sess-1", status: "ended" });
    expect(channel.edit).toHaveBeenCalledWith(expect.objectContaining({ parent: "archive-cat" }));
  });
});
