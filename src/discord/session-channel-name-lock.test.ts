import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType } from "discord.js";
import { onSessionChannelNameLocked, onSessionTitleChanged } from "./session-channel.js";

// /ch_name でチャンネル名を固定すると、 以後 title (= 処理内容) 由来の forceRename が
// 来てもチャンネル名は変わらず (topic だけ更新)、 ユーザ指定名が維持されることを検証する。

const SESSION_ID = "sess-lock-1";
const CHANNEL_ID = "chan-lock-1";

function makeMocks() {
  const rows = new Map<string, any>();
  rows.set(SESSION_ID, {
    session_id: SESSION_ID,
    channel_id: CHANNEL_ID,
    status: "active",
    display_state: "active",
    agent_type: "claude",
    name_body: "anon",
    delegation_emoji: null,
    name_locked: 0,
  });
  const repo = {
    findBySessionId: vi.fn((id: string) => rows.get(id) ?? null),
    setNameLock: vi.fn((id: string, body: string) => {
      const r = rows.get(id);
      if (r) { r.name_body = body; r.name_locked = 1; }
    }),
    setDisplayState: vi.fn(),
  };

  const edit = vi.fn(async (patch: any) => {
    if (patch.name) channelObj.name = patch.name;
  });
  const channelObj = { id: CHANNEL_ID, name: "🟢🤖-anon", type: ChannelType.GuildText, edit };
  const cache = new Map<string, any>([[CHANNEL_ID, channelObj]]);
  const guild = { channels: { cache } };
  const log = { info: vi.fn(), warn: vi.fn() };
  const layout = { sessionsCategoryId: "cat" } as any;
  return { guild, repo, log, layout, channelObj, edit };
}

describe("/ch_name — チャンネル名固定", () => {
  beforeEach(() => vi.clearAllMocks());

  it("name_locked を立て、 サニタイズした body で即リネームする", async () => {
    const m = makeMocks();
    const r = await onSessionChannelNameLocked(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: SESSION_ID, name: "My Fixed Name!!", agentType: null },
    );
    expect(r.ok).toBe(true);
    expect(m.repo.setNameLock).toHaveBeenCalledWith(SESSION_ID, "my-fixed-name");
    expect(m.edit).toHaveBeenCalledTimes(1);
    expect(m.channelObj.name).toContain("-my-fixed-name");
  });

  it("固定後は title 由来の forceRename でチャンネル名を変えない (topic のみ)", async () => {
    const m = makeMocks();
    await onSessionChannelNameLocked(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: SESSION_ID, name: "keepme", agentType: null },
    );
    m.edit.mockClear();
    const nameBefore = m.channelObj.name;

    await onSessionTitleChanged(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: SESSION_ID, title: "別の処理内容に変わった", agentType: "claude", forceRename: true },
    );
    // edit は topic 更新で呼ばれるが name は含まれない → チャンネル名は不変。
    expect(m.edit).toHaveBeenCalledTimes(1);
    expect(m.edit.mock.calls[0][0].name).toBeUndefined();
    expect(m.channelObj.name).toBe(nameBefore);
  });
});
