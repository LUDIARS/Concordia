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
