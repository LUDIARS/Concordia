import { describe, expect, it, vi } from "vitest";
import { openGlabUnityHubDb, SqliteGlabUnityStore } from "../adapters/sqlite-store.js";
import { GlabUnityTokenService } from "./token-service.js";
import { HubAuthenticator, bearerToken } from "./authenticate.js";
import { GeoGuard } from "./geo-guard.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { HubSession, type HubSocket } from "./hub-session.js";
import type { MethodContext, MethodHandlers } from "./method-context.js";
import type { DiscordGateway, HubMember, OverseasNotifier } from "./ports.js";
import { hashToken, TOKEN_PREFIX } from "../domain/token-policy.js";
import type { GeoPolicy } from "../domain/geo-policy.js";

const GLAB = "222222222222222222";
const ALICE = "111111111111111111";
const BOB = "333333333333333333";

class FakeSocket implements HubSocket {
  readonly sent: unknown[] = [];
  closedWith: { code: number; reason: string } | null = null;
  send(text: string): void { this.sent.push(JSON.parse(text)); }
  close(code: number, reason: string): void { this.closedWith = { code, reason }; }
}

function harness(options: { policy?: GeoPolicy; members?: string[] } = {}) {
  const clock = { now: () => new Date("2026-11-26T00:00:00.000Z") };
  const store = new SqliteGlabUnityStore(openGlabUnityHubDb(":memory:"), clock.now);
  const tokens = new GlabUnityTokenService({ store, audit: store, clock, glabGuildId: GLAB });
  const members = new Set(options.members ?? [ALICE, BOB]);
  const discord: Pick<DiscordGateway, "member"> = {
    member: async (id): Promise<HubMember | null> => (members.has(id) ? { discordUserId: id, displayName: `name-${id.slice(0, 3)}`, avatarUrl: null } : null),
  };
  const authenticator = new HubAuthenticator({ store, discord, clock });
  const notices: unknown[] = [];
  const notifier: OverseasNotifier = { notify: async (input) => { notices.push(input); } };
  const geo = new GeoGuard({ allowedCountries: ["JP"], policy: options.policy ?? "block", audit: store, notifier, clock });
  const registry = new ConnectionRegistry();
  const handlers = {
    "hub.whoami": async (context: MethodContext) => ({ discordUserId: context.identity.token.discordUserId }),
    "discord.messages.post": async () => ({ messageId: "m" }),
    "discord.subscribe": async (context: MethodContext, payload: { channelId: string }) => {
      context.subscriptions.subscribe(payload.channelId);
      return {};
    },
  } as unknown as MethodHandlers;
  const timers: Array<() => void> = [];
  const open = (input: { authorization?: string; cfCountry?: string | null; remote?: string; cf?: boolean } = {}) => {
    const socket = new FakeSocket();
    const cf = input.cf ?? true;
    const session = new HubSession({
      socket,
      origin: {
        cfCountry: cf ? (input.cfCountry === undefined ? "JP" : input.cfCountry) : null,
        cfConnectingIp: cf ? "203.0.113.9" : null,
        remoteAddress: input.remote ?? "127.0.0.1",
      },
      authorization: input.authorization,
      authenticator, geo, registry, handlers, audit: store, clock,
      setTimer: (fn) => { timers.push(fn); return { cancel: () => undefined }; },
    });
    return { socket, session };
  };
  const audit = () => (store as unknown as { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).db
    .prepare("SELECT kind, operation, result, country, ip FROM glab_unity_audit ORDER BY id").all();
  return { store, tokens, registry, open, timers, notices, audit, members };
}

function issue(h: ReturnType<typeof harness>, user = ALICE): string {
  const result = h.tokens.issue({ discordUserId: user, guildId: GLAB }, "test");
  if (!result.ok) throw new Error(result.reason);
  return result.token;
}

const frame = (value: unknown) => JSON.stringify(value);

describe("トークン発行 (本人限定・ハッシュ保存)", () => {
  it("打った本人の分だけ発行し、 DB には平文を残さない", () => {
    const h = harness();
    const token = issue(h);
    const rows = h.store.listByUser(ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(h.store.listByUser(BOB)).toHaveLength(0);
  });

  it("GLab 以外の guild・DM からは発行・一覧・失効しない", () => {
    const h = harness();
    expect(h.tokens.issue({ discordUserId: ALICE, guildId: null }, null)).toEqual({ ok: false, reason: "wrong_guild" });
    expect(h.tokens.issue({ discordUserId: ALICE, guildId: "999999999999999999" }, null)).toEqual({ ok: false, reason: "wrong_guild" });
    expect(h.tokens.list({ discordUserId: ALICE, guildId: null })).toEqual({ ok: false, reason: "wrong_guild" });
  });

  it("有効トークンは 3 本まで", () => {
    const h = harness();
    issue(h); issue(h); issue(h);
    expect(h.tokens.issue({ discordUserId: ALICE, guildId: GLAB }, null)).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("他人のトークンは失効できない", () => {
    const h = harness();
    const aliceToken = issue(h, ALICE);
    const prefix = aliceToken.slice(0, 12);
    expect(h.tokens.revoke({ discordUserId: BOB, guildId: GLAB }, prefix)).toEqual({ ok: false, reason: "not_found" });
    expect(h.tokens.revoke({ discordUserId: ALICE, guildId: GLAB }, prefix)).toEqual({ ok: true, displayPrefix: prefix });
  });
});

describe("WS の認証 (2 経路)", () => {
  it("Authorization: Bearer で即座に認証する", async () => {
    const h = harness();
    const { socket, session } = h.open({ authorization: `Bearer ${issue(h)}` });
    await session.start();
    expect(session.isOpen()).toBe(true);
    await session.receive(frame({ v: 1, id: "r1", type: "hub.whoami", payload: {} }), false);
    expect(socket.sent).toEqual([{ v: 1, id: "r1", type: "result", payload: { discordUserId: ALICE } }]);
  });

  it("ヘッダが無ければ最初の auth フレームで認証する", async () => {
    const h = harness();
    const { socket, session } = h.open();
    await session.start();
    await session.receive(frame({ v: 1, id: "a", type: "auth", payload: { token: issue(h) } }), false);
    expect(session.isOpen()).toBe(true);
    expect(socket.sent[0]).toEqual({ v: 1, id: "a", type: "result", payload: { authenticated: true } });
  });

  it("5 秒以内に auth が無ければ 4401", async () => {
    const h = harness();
    const { socket, session } = h.open();
    await session.start();
    h.timers[0]!();
    expect(socket.closedWith?.code).toBe(4401);
  });

  it("auth より先に要求が来たら 4401", async () => {
    const h = harness();
    const { socket, session } = h.open();
    await session.start();
    await session.receive(frame({ v: 1, id: "r", type: "hub.whoami", payload: {} }), false);
    expect(socket.closedWith?.code).toBe(4401);
  });

  it("未知・失効・期限切れは 4401、 GLab から抜けた人は 4403", async () => {
    const h = harness();
    const unknown = TOKEN_PREFIX + "A".repeat(43);
    const a = h.open({ authorization: `Bearer ${unknown}` });
    await a.session.start();
    expect(a.socket.closedWith?.code).toBe(4401);

    const revoked = issue(h);
    h.tokens.revoke({ discordUserId: ALICE, guildId: GLAB }, revoked.slice(0, 12));
    const b = h.open({ authorization: `Bearer ${revoked}` });
    await b.session.start();
    expect(b.socket.closedWith?.code).toBe(4401);

    const leaver = issue(h, BOB);
    h.members.delete(BOB);
    const c = h.open({ authorization: `Bearer ${leaver}` });
    await c.session.start();
    expect(c.socket.closedWith?.code).toBe(4403);
    expect(bearerToken("Basic x")).toBeNull();
  });

  it("失効すると接続中の WS を 4401 で切る (registry 経由)", async () => {
    const h = harness();
    const token = issue(h);
    const { socket, session } = h.open({ authorization: `Bearer ${token}` });
    await session.start();
    const stored = h.store.findByHash(hashToken(token))!;
    h.tokens.revoke({ discordUserId: ALICE, guildId: GLAB }, token.slice(0, 12));
    expect(h.store.revokedSince("2000-01-01T00:00:00.000Z")).toEqual([stored.id]);
    expect(h.registry.closeTokens(h.store.revokedSince("2000-01-01T00:00:00.000Z"))).toBe(1);
    expect(socket.closedWith?.code).toBe(4401);
  });

  it("失効後の要求は要求ごとの見直しでも切る", async () => {
    const h = harness();
    const token = issue(h);
    const { socket, session } = h.open({ authorization: `Bearer ${token}` });
    await session.start();
    h.tokens.revoke({ discordUserId: ALICE, guildId: GLAB }, token.slice(0, 12));
    await session.receive(frame({ v: 1, id: "r", type: "hub.whoami", payload: {} }), false);
    expect(socket.closedWith?.code).toBe(4401);
  });
});

describe("WS の海外監視", () => {
  it("block: 許可国外は記録・通知して 4403", async () => {
    const h = harness({ policy: "block" });
    const { socket, session } = h.open({ authorization: `Bearer ${issue(h)}`, cfCountry: "US" });
    await session.start();
    expect(socket.closedWith?.code).toBe(4403);
    expect(h.notices).toHaveLength(1);
    expect(h.audit().some((row) => row.result === "overseas_blocked" && row.country === "US" && row.ip === "203.0.113.*")).toBe(true);
  });

  it("monitor: 通して記録・通知し、 同一トークン・同一国の通知は 1 時間に 1 回", async () => {
    const h = harness({ policy: "monitor" });
    const token = issue(h);
    for (let i = 0; i < 2; i += 1) {
      const { session } = h.open({ authorization: `Bearer ${token}`, cfCountry: "US" });
      await session.start();
      expect(session.isOpen()).toBe(true);
      session.terminate(1000, "done");
    }
    expect(h.notices).toHaveLength(1);
    expect(h.audit().filter((row) => row.result === "overseas_monitored")).toHaveLength(2);
  });

  it("CF ヘッダ無しで loopback 以外からは 4403、 loopback は通す", async () => {
    const h = harness();
    const token = issue(h);
    const remote = h.open({ authorization: `Bearer ${token}`, cf: false, remote: "192.0.2.5" });
    await remote.session.start();
    expect(remote.socket.closedWith?.code).toBe(4403);
    const local = h.open({ authorization: `Bearer ${token}`, cf: false, remote: "127.0.0.1" });
    await local.session.start();
    expect(local.session.isOpen()).toBe(true);
  });
});

describe("WS の制限", () => {
  it("1 トークンの同時接続は 2 本まで", async () => {
    const h = harness();
    const token = issue(h);
    const sessions = [h.open({ authorization: `Bearer ${token}` }), h.open({ authorization: `Bearer ${token}` }), h.open({ authorization: `Bearer ${token}` })];
    for (const entry of sessions) await entry.session.start();
    expect(sessions[0]!.session.isOpen() && sessions[1]!.session.isOpen()).toBe(true);
    expect(sessions[2]!.socket.sent[0]).toMatchObject({ type: "error", payload: { code: "rate_limited" } });
    expect(sessions[2]!.socket.closedWith?.code).toBe(1008);
  });

  it("1 接続 毎分 60 要求を超えたら rate_limited", async () => {
    const h = harness();
    const { socket, session } = h.open({ authorization: `Bearer ${issue(h)}` });
    await session.start();
    for (let i = 0; i < 61; i += 1) await session.receive(frame({ v: 1, id: `r${i}`, type: "hub.whoami", payload: {} }), false);
    expect(socket.sent[60]).toMatchObject({ id: "r60", type: "error", payload: { code: "rate_limited" } });
  });

  it("投稿は 1 ユーザー毎分 10 件 (接続をまたいで数える)", async () => {
    const h = harness();
    const token = issue(h);
    const a = h.open({ authorization: `Bearer ${token}` });
    const b = h.open({ authorization: `Bearer ${token}` });
    await a.session.start();
    await b.session.start();
    const post = (id: string) => frame({ v: 1, id, type: "discord.messages.post", payload: { channelId: "123456789012345678", content: "hi" } });
    for (let i = 0; i < 6; i += 1) await a.session.receive(post(`a${i}`), false);
    for (let i = 0; i < 5; i += 1) await b.session.receive(post(`b${i}`), false);
    expect(b.socket.sent[4]).toMatchObject({ id: "b4", type: "error", payload: { code: "rate_limited" } });
  });

  it("バイナリと壊れたフレームは invalid_request", async () => {
    const h = harness();
    const { socket, session } = h.open({ authorization: `Bearer ${issue(h)}` });
    await session.start();
    await session.receive(Buffer.from([1, 2]), true);
    await session.receive("{", false);
    expect(socket.sent.map((entry) => (entry as { payload: { code: string } }).payload.code)).toEqual(["invalid_request", "invalid_request"]);
  });

  it("購読したチャンネルの event だけ受ける、 抜けた人は 4403 で切る", async () => {
    const h = harness();
    const { socket, session } = h.open({ authorization: `Bearer ${issue(h)}` });
    await session.start();
    await session.receive(frame({ v: 1, id: "s", type: "discord.subscribe", payload: { channelId: "123456789012345678" } }), false);
    const canRead = vi.fn(async () => true);
    await h.registry.deliverDiscordMessage("123456789012345678", { id: "m", authorName: "x", content: "c", createdAt: "t", attachments: [] }, canRead);
    await h.registry.deliverDiscordMessage("999999999999999999", { id: "n", authorName: "x", content: "c", createdAt: "t", attachments: [] }, canRead);
    expect(socket.sent.filter((entry) => (entry as { type: string }).type === "event")).toHaveLength(1);
    expect(h.registry.closeUser(ALICE)).toBe(1);
    expect(socket.closedWith?.code).toBe(4403);
  });
});
