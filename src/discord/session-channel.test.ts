import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType } from "discord.js";
import { WebhookPool } from "./webhook-pool.js";
import { onSessionRegistered, onSessionStatusChanged, onSessionTitleChanged, reconcileEndedSessionChannels, reconcileLostSessionChannels } from "./session-channel.js";

// onSessionRegistered が「セッション spawn (= channel 作成) と同時に webhook を
// eager 作成し token を永続化する」ことを検証する。 これで以降の egress は
// getForSession の DB-token パスに直行し、 遅延作成 (thundering-herd 対策の
// in-flight / 既存再利用) を踏まない。 discord.js / repo は最小モック。

const SESSION_ID = "sess-eager-1";
const CHANNEL_ID = "chan-eager-1";
const WEBHOOK_ID = "123456789012345679"; // WebhookClient は snowflake を要求するので数値 id

function makeMocks() {
  // in-memory な session-channels repo (upsert ↔ setWebhook ↔ findBySessionId を共有)
  const rows = new Map<string, any>();
  const repo = {
    findBySessionId: vi.fn((id: string) => rows.get(id) ?? null),
    upsert: vi.fn((r: any) => {
      rows.set(r.session_id, { ...r, webhook_id: null, webhook_token: null });
    }),
    setWebhook: vi.fn((id: string, whId: string, tok: string) => {
      const r = rows.get(id);
      if (r) {
        r.webhook_id = whId;
        r.webhook_token = tok;
      }
    }),
  };

  const createWebhook = vi.fn(async () => ({ id: WEBHOOK_ID, token: "tok-eager" }));
  const fetchWebhooks = vi.fn(async () => []);
  const channelObj = {
    id: CHANNEL_ID,
    name: "🟢 sess",
    type: ChannelType.GuildText,
    createWebhook,
    fetchWebhooks,
  };

  const cache = new Map<string, any>();
  const guild = {
    channels: {
      cache,
      // discord.js の create() と同様に作成した channel を cache にも載せる
      // (ensureWebhookForChannel は cache.get(channelId) で引くため)。
      create: vi.fn(async () => {
        cache.set(CHANNEL_ID, channelObj);
        return channelObj;
      }),
    },
    client: { user: { id: "bot" } },
  };

  const webhooks = new WebhookPool(guild as any, repo as any);
  const log = { info: vi.fn(), warn: vi.fn() };
  const layout = { sessionsCategoryId: "cat" } as any;
  return { guild, repo, webhooks, log, layout, channelObj, createWebhook };
}

function register(m: ReturnType<typeof makeMocks>) {
  return onSessionRegistered(
    { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log, webhooks: m.webhooks },
    { sessionId: SESSION_ID, agentType: "claude", roleLabel: null },
  );
}

describe("onSessionRegistered — spawn と同時に webhook を eager 作成", () => {
  beforeEach(() => vi.clearAllMocks());

  it("channel 作成 + upsert + webhook を 1 回作って token を永続化する", async () => {
    const m = makeMocks();
    await register(m);
    expect(m.guild.channels.create).toHaveBeenCalledTimes(1);
    expect(m.repo.upsert).toHaveBeenCalledTimes(1);
    expect(m.createWebhook).toHaveBeenCalledTimes(1);
    expect(m.repo.setWebhook).toHaveBeenCalledWith(SESSION_ID, WEBHOOK_ID, "tok-eager");
    expect(m.repo.findBySessionId(SESSION_ID)?.webhook_token).toBe("tok-eager");
  });

  it("eager 作成済みなら以降の getForSession は createWebhook を呼ばない (遅延パス no-op)", async () => {
    const m = makeMocks();
    await register(m);
    m.createWebhook.mockClear();
    const client = await m.webhooks.getForSession(SESSION_ID);
    expect(client).not.toBeNull();
    expect(m.createWebhook).not.toHaveBeenCalled();
  });

  it("webhooks 未指定でも従来どおり channel 作成 + upsert はできる (eager はスキップ)", async () => {
    const m = makeMocks();
    await onSessionRegistered(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: SESSION_ID, agentType: "claude", roleLabel: null },
    );
    expect(m.repo.upsert).toHaveBeenCalledTimes(1);
    expect(m.createWebhook).not.toHaveBeenCalled();
  });
});

describe("onSessionStatusChanged ended archive", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeEndedArchiveMocks() {
    const row: any = {
      session_id: "sess-ended-1",
      channel_id: "chan-ended-1",
      webhook_id: null,
      webhook_token: null,
      status: "ended",
      display_state: "ended",
      agent_type: "claude-code",
      name_body: "task",
      delegation_emoji: null,
      last_rename_ts: 0,
      scope: "sub:child",
      name_locked: 0,
      ts: 1,
    };
    const channelObj: any = {
      id: row.channel_id,
      name: "old-task",
      parentId: "sessions-cat",
      type: ChannelType.GuildText,
      edit: vi.fn(async (patch: any) => {
        if (patch.name) channelObj.name = patch.name;
        if (patch.parent) channelObj.parentId = patch.parent;
        return channelObj;
      }),
    };
    const cache = new Map<string, any>([[row.channel_id, channelObj]]);
    const guild = {
      channels: {
        cache,
        fetch: vi.fn(async (id?: string) => (id ? (id === row.channel_id ? channelObj : null) : cache)),
      },
    };
    const repo = {
      findBySessionId: vi.fn((id: string) => (id === row.session_id ? row : null)),
      listAll: vi.fn(() => [row]),
      setStatus: vi.fn((id: string, status: string) => {
        if (id === row.session_id) row.status = status;
      }),
      setDisplayState: vi.fn((id: string, state: string) => {
        if (id === row.session_id) row.display_state = state;
      }),
      clearWebhook: vi.fn(),
    };
    const isSessionEnded = vi.fn((id: string) => id === row.session_id);
    const log = { info: vi.fn(), warn: vi.fn() };
    const layout = { archiveCategoryId: "archive-cat", sessionsCategoryId: "sessions-cat" } as any;
    return { row, channelObj, guild, repo, isSessionEnded, log, layout };
  }

  it("retries archive even when the channel row is already ended", async () => {
    const m = makeEndedArchiveMocks();

    await onSessionStatusChanged(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: m.row.session_id, status: "ended" },
    );

    expect(m.channelObj.edit).toHaveBeenCalledWith(expect.objectContaining({
      parent: "archive-cat",
      name: expect.any(String),
    }));
  });

  it("reconciles ended sessions whose channels are still outside archive", async () => {
    const m = makeEndedArchiveMocks();

    const result = await reconcileEndedSessionChannels({
      guild: m.guild as any,
      layout: m.layout,
      repo: m.repo as any,
      isSessionEnded: m.isSessionEnded,
      log: m.log,
    });

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    expect(m.channelObj.parentId).toBe("archive-cat");
  });

  it("fetches an uncached channel before archiving an ended session", async () => {
    const m = makeEndedArchiveMocks();
    m.guild.channels.cache.delete(m.row.channel_id);

    await onSessionStatusChanged(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: m.row.session_id, status: "ended" },
    );

    expect(m.guild.channels.fetch).toHaveBeenCalledWith(m.row.channel_id);
    expect(m.channelObj.parentId).toBe("archive-cat");
  });
});

describe("onSessionStatusChanged lost archive", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeLostArchiveMocks(status: "active" | "lost" = "active") {
    const row: any = {
      session_id: "sess-lost-1",
      channel_id: "chan-lost-1",
      webhook_id: null,
      webhook_token: null,
      status,
      display_state: status,
      agent_type: "codex-cli",
      name_body: "task",
      delegation_emoji: null,
      last_rename_ts: 0,
      scope: "sub:child",
      name_locked: 0,
      ts: 1,
    };
    const channelObj: any = {
      id: row.channel_id,
      name: "old-task",
      parentId: "sessions-cat",
      type: ChannelType.GuildText,
      edit: vi.fn(async (patch: any) => {
        if (patch.name) channelObj.name = patch.name;
        if (patch.parent) channelObj.parentId = patch.parent;
        return channelObj;
      }),
    };
    const cache = new Map<string, any>([[row.channel_id, channelObj]]);
    const guild = {
      channels: {
        cache,
        fetch: vi.fn(async (id?: string) => (id ? (id === row.channel_id ? channelObj : null) : cache)),
      },
    };
    const repo = {
      findBySessionId: vi.fn((id: string) => (id === row.session_id ? row : null)),
      listAll: vi.fn(() => [row]),
      setStatus: vi.fn((id: string, nextStatus: string) => {
        if (id === row.session_id) row.status = nextStatus;
      }),
      setDisplayState: vi.fn((id: string, state: string) => {
        if (id === row.session_id) row.display_state = state;
      }),
      tryClaimRename: vi.fn(() => true),
    };
    const log = { info: vi.fn(), warn: vi.fn() };
    const layout = { archiveCategoryId: "archive-cat", sessionsCategoryId: "sessions-cat" } as any;
    return { row, channelObj, guild, repo, log, layout };
  }

  it("moves a lost session channel to archive without rename cooldown", async () => {
    const m = makeLostArchiveMocks();

    await onSessionStatusChanged(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: m.row.session_id, status: "lost" },
    );

    expect(m.repo.tryClaimRename).not.toHaveBeenCalled();
    expect(m.row.status).toBe("lost");
    expect(m.row.display_state).toBe("lost");
    expect(m.channelObj.edit).toHaveBeenCalledWith(expect.objectContaining({
      parent: "archive-cat",
      name: expect.any(String),
    }));
    expect(m.channelObj.parentId).toBe("archive-cat");
  });

  it("reconciles active channel rows whose session is already lost", async () => {
    const m = makeLostArchiveMocks("active");

    const result = await reconcileLostSessionChannels({
      guild: m.guild as any,
      layout: m.layout,
      repo: m.repo as any,
      isSessionLost: (sessionId) => sessionId === m.row.session_id,
      log: m.log,
    });

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    expect(m.row.status).toBe("lost");
    expect(m.channelObj.parentId).toBe("archive-cat");
  });

  it("retries archive when a lost channel row is still outside archive", async () => {
    const m = makeLostArchiveMocks("lost");

    const result = await reconcileLostSessionChannels({
      guild: m.guild as any,
      layout: m.layout,
      repo: m.repo as any,
      isSessionLost: () => false,
      log: m.log,
    });

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    expect(m.channelObj.parentId).toBe("archive-cat");
  });

  it("preserves the delegation emoji when a lost channel becomes active again", async () => {
    const m = makeLostArchiveMocks("lost");
    m.row.delegation_emoji = "🧭";

    await onSessionStatusChanged(
      { guild: m.guild as any, layout: m.layout, repo: m.repo as any, log: m.log },
      { sessionId: m.row.session_id, status: "active" },
    );

    expect(m.channelObj.edit).toHaveBeenCalledWith(expect.objectContaining({
      name: "🟢🧭-task",
    }));
  });
});

describe("onSessionTitleChanged forum thread", () => {
  it("preserves the delegation emoji during automatic title updates", async () => {
    const row: any = {
      session_id: "session-delegation-1",
      channel_id: "thread-1",
      channel_kind: "thread",
      status: "active",
      display_state: "active",
      agent_type: "codex-cli",
      name_body: "delegation",
      delegation_emoji: "🧭",
      name_locked: 0,
    };
    const thread: any = {
      id: row.channel_id,
      type: ChannelType.PublicThread,
      parent: { type: ChannelType.GuildForum },
      setName: vi.fn(async (name: string) => {
        thread.name = name;
      }),
    };
    const repo = {
      findBySessionId: vi.fn(() => row),
      setDisplayState: vi.fn(),
    };
    const guild = { channels: { cache: new Map([[row.channel_id, thread]]) } };

    await onSessionTitleChanged(
      { guild: guild as any, layout: {} as any, repo: repo as any, log: { info: vi.fn(), warn: vi.fn() } },
      {
        sessionId: row.session_id,
        title: "Review delegation",
        agentType: "codex-cli",
        projectCode: "Cc",
      },
    );

    expect(thread.setName).toHaveBeenCalledWith(
      "🧭 [Cc] Review delegation",
      "Concordia session title updated",
    );
  });
});
