import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType } from "discord.js";
import { WebhookPool } from "./webhook-pool.js";

// discord.js / repo の最小モック。 webhook 作成の集約 (in-flight dedup) と
// 既存 webhook 再利用だけを検証する。 ネットワークは張らない。
const CHANNEL_ID = "1511487831422402712";
const WEBHOOK_ID = "123456789012345678";

function makeChannel(opts: { existing?: boolean; createImpl?: () => Promise<any> }) {
  const create = vi.fn(
    opts.createImpl ?? (async () => ({ id: WEBHOOK_ID, token: "tok-created" })),
  );
  const fetch = vi.fn(async () =>
    opts.existing
      ? [{ id: WEBHOOK_ID, token: "tok-existing", name: "Concordia", owner: { id: "bot" } }]
      : [],
  );
  return {
    type: ChannelType.GuildText,
    createWebhook: create,
    fetchWebhooks: fetch,
    _create: create,
    _fetch: fetch,
  };
}

function makePool(channel: any, row: any) {
  const guild = {
    channels: { cache: new Map<string, any>([[CHANNEL_ID, channel]]) },
    client: { user: { id: "bot" } },
  };
  const setWebhook = vi.fn();
  const repo = {
    findBySessionId: vi.fn(() => row),
    setWebhook,
  };
  const pool = new WebhookPool(guild as any, repo as any);
  return { pool, setWebhook, repo };
}

describe("WebhookPool — webhook 上限への雷鳴的到達の防止", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getForChannel: 並行 10 呼び出しでも createWebhook は 1 回だけ", async () => {
    const ch = makeChannel({});
    const { pool } = makePool(ch, null);
    const clients = await Promise.all(
      Array.from({ length: 10 }, () => pool.getForChannel(CHANNEL_ID)),
    );
    expect(ch._create).toHaveBeenCalledTimes(1);
    // 全て同一 client (cache 共有)
    expect(new Set(clients).size).toBe(1);
    expect(clients[0]).not.toBeNull();
  });

  it("getForSession: 並行呼び出しでも createWebhook / setWebhook は 1 回だけ", async () => {
    const ch = makeChannel({});
    const row = { channel_id: CHANNEL_ID, webhook_id: null, webhook_token: null };
    const { pool, setWebhook } = makePool(ch, row);
    await Promise.all(Array.from({ length: 8 }, () => pool.getForSession("sess-1")));
    expect(ch._create).toHaveBeenCalledTimes(1);
    expect(setWebhook).toHaveBeenCalledTimes(1);
    expect(setWebhook).toHaveBeenCalledWith("sess-1", WEBHOOK_ID, "tok-created");
  });

  it("既存の bot 所有 webhook があれば再利用して createWebhook を呼ばない", async () => {
    const ch = makeChannel({ existing: true });
    const { pool } = makePool(ch, null);
    const client = await pool.getForChannel(CHANNEL_ID);
    expect(client).not.toBeNull();
    expect(ch._create).not.toHaveBeenCalled();
    expect(ch._fetch).toHaveBeenCalledTimes(1);
  });

  it("createWebhook が上限エラーを投げたら null を返し、 in-flight をクリアして次回再試行できる", async () => {
    let calls = 0;
    const ch = makeChannel({
      createImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Maximum number of webhooks reached (15)");
        return { id: WEBHOOK_ID, token: "tok-2" };
      },
    });
    const { pool } = makePool(ch, null);
    const first = await pool.getForChannel(CHANNEL_ID);
    expect(first).toBeNull();
    // in-flight がクリアされているので 2 回目は再試行され成功する
    const second = await pool.getForChannel(CHANNEL_ID);
    expect(second).not.toBeNull();
    expect(ch._create).toHaveBeenCalledTimes(2);
  });
});

describe("WebhookPool.purgeChannel — archived channel の webhook budget 解放", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeChannelWithHooks(hooks: any[]) {
    return {
      type: ChannelType.GuildText,
      fetchWebhooks: vi.fn(async () => hooks),
      createWebhook: vi.fn(),
    };
  }
  function hook(id: string, ownerId: string, name = "Concordia", token?: string) {
    return { id, name, token, owner: { id: ownerId }, delete: vi.fn(async () => {}) };
  }

  it("bot 所有 (Concordia) webhook だけを全削除し、他人/別名は残す", async () => {
    const mine1 = hook("w1", "bot");
    const mine2 = hook("w2", "bot");
    const other = hook("w3", "someone-else");
    const named = hook("w4", "bot", "OtherHook");
    const ch = makeChannelWithHooks([mine1, mine2, other, named]);
    const { pool } = makePool(ch, null);

    const deleted = await pool.purgeChannel(CHANNEL_ID);

    expect(deleted).toBe(2);
    expect(mine1.delete).toHaveBeenCalledTimes(1);
    expect(mine2.delete).toHaveBeenCalledTimes(1);
    expect(other.delete).not.toHaveBeenCalled();
    expect(named.delete).not.toHaveBeenCalled();
  });

  it("purge 後は cache をクリアするので次回 getForChannel が作り直す", async () => {
    const existing = hook("w1", "bot", "Concordia", "tok-existing");
    const ch: any = makeChannelWithHooks([existing]);
    const { pool } = makePool(ch, null);

    await pool.getForChannel(CHANNEL_ID); // cache に載る
    await pool.purgeChannel(CHANNEL_ID);  // 削除 + cache クリア
    expect(existing.delete).toHaveBeenCalledTimes(1);
    // cache がクリアされているので再度 fetchWebhooks が走る
    await pool.getForChannel(CHANNEL_ID);
    // getForChannel#1 + purge + getForChannel#2 = 3 回
    expect(ch.fetchWebhooks).toHaveBeenCalledTimes(3);
  });

  it("text channel でなければ 0 を返す (no-op)", async () => {
    const guild = { channels: { cache: new Map() }, client: { user: { id: "bot" } } };
    const pool = new WebhookPool(guild as any, { findBySessionId: () => null } as any);
    expect(await pool.purgeChannel("missing")).toBe(0);
  });
});
