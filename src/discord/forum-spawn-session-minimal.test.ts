import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { SESSION_STATE_TAG_NAMES } from "./config.js";
import { bindForumSpawnSession, MINIMAL_SURFACE_CONTENT } from "./forum-spawn-session.js";

// 部署の出力方針でセッション情報表示を止めたとき、 webhook の面は作ったまま本文だけ
// 1 行にする (spec/feature/departments.md §9.4)。
describe("bindForumSpawnSession minimal surface", () => {
  function fixture() {
    const thread: Record<string, unknown> = {
      id: "thread-qa",
      parentId: "forum-qa",
      type: ChannelType.PublicThread,
      isThread: () => true,
      archived: false,
      appliedTags: [],
      edit: vi.fn(async () => thread),
    };
    thread.parent = { id: "forum-qa", type: ChannelType.GuildForum, availableTags: [{ id: "active", name: SESSION_STATE_TAG_NAMES.active }] };
    const channels = new Map<string, unknown>([["thread-qa", thread]]);
    const rows = new Map<string, Record<string, unknown>>();
    const createForumSessionSurface = vi.fn(async () => ({ messageId: "m-1", webhookId: "w-1", webhookToken: "t-1" }));
    return {
      createForumSessionSurface,
      rows,
      deps: {
        guild: { id: "guild-1", channels: { cache: channels, fetch: vi.fn(async (id: string) => channels.get(id) ?? null) } },
        sessionForumId: "forum-qa",
        repo: {
          findBySessionId: (id: string) => rows.get(id) ?? null,
          upsert: (row: Record<string, unknown>) => { rows.set(String(row.session_id), { ...row }); },
          setWebhook: (id: string, webhookId: string, webhookToken: string) => { Object.assign(rows.get(id)!, { webhook_id: webhookId, webhook_token: webhookToken }); },
        },
        webhooks: { createForumSessionSurface },
        log: { info: vi.fn() },
      },
    };
  }

  it("posts a one-line surface but keeps the webhook binding", async () => {
    const { deps, createForumSessionSurface, rows } = fixture();
    await bindForumSpawnSession(deps as never, {
      sessionId: "qa-1", threadId: "thread-qa", provider: "claude", repoPath: "E:/work", branch: null,
      callName: null, state: null, minimalSurface: true,
    });
    expect(createForumSessionSurface).toHaveBeenCalledWith("forum-qa", "thread-qa", expect.objectContaining({ content: MINIMAL_SURFACE_CONTENT }));
    expect(rows.get("qa-1")).toMatchObject({ surface_message_id: "m-1", webhook_id: "w-1" });
  });

  it("keeps the full session info by default", async () => {
    const { deps, createForumSessionSurface } = fixture();
    await bindForumSpawnSession(deps as never, {
      sessionId: "dev-1", threadId: "thread-qa", provider: "claude", repoPath: "E:/work", branch: "feat/x",
      callName: null, state: null,
    });
    const [, , payload] = createForumSessionSurface.mock.calls[0] as unknown as [string, string, { content: string }];
    expect(payload.content).not.toBe(MINIMAL_SURFACE_CONTENT);
    expect(payload.content).toContain("dev-1");
  });
});
