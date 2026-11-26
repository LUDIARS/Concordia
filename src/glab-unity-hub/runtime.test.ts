import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGlabUnityHubRuntime, REVOCATION_POLL_MS } from "./runtime.js";
import { openGlabUnityHubDb, SqliteGlabUnityStore } from "./adapters/sqlite-store.js";
import { resolveGlabUnityHubConfig } from "./adapters/hub-config.js";
import { GlabUnityTokenService } from "./application/token-service.js";
import type { PortusModules } from "./adapters/portus-loader.js";
import type { DiscordGateway, OverseasNotifier } from "./application/ports.js";

const GLAB = "222222222222222222";
const USER = "111111111111111111";

function fakePortus(): PortusModules {
  return {
    createHttpServer: () => {
      const server = createServer();
      return {
        server,
        listen: async () => ({ address: "127.0.0.1", family: "IPv4", port: 49999 }),
        close: async () => undefined,
      };
    },
    json: (_value, status = 200) => ({ status }),
    WebSocket: class extends EventEmitter {
      readyState = 1;
      attach() { /* no-op */ }
      send() { /* no-op */ }
      ping() { /* no-op */ }
      close() { /* no-op */ }
    } as unknown as PortusModules["WebSocket"],
  };
}

function fakeDiscord(): DiscordGateway & OverseasNotifier & { leave?: (id: string) => void } {
  const gateway: DiscordGateway & OverseasNotifier & { leave?: (id: string) => void } = {
    member: async (id) => ({ discordUserId: id, displayName: "neco", avatarUrl: null }),
    listChannels: async () => [],
    access: async () => null,
    listMessages: async () => [],
    postAs: async () => ({ messageId: "m" }),
    react: async () => undefined,
    uploadLogs: async () => [],
    onMessage: () => () => undefined,
    onMemberLeave: (listener) => { gateway.leave = listener; return () => undefined; },
    notify: async () => undefined,
  };
  return gateway;
}

afterEach(() => { vi.useRealTimers(); });

describe("GLab-UnityHub runtime", () => {
  it("失効を 2 秒以内に拾って接続中のセッションを 4401 で切る", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00.000Z") });
    const store = new SqliteGlabUnityStore(openGlabUnityHubDb(":memory:"));
    const config = { ...resolveGlabUnityHubConfig({}, {}, "/x"), guildId: GLAB, port: 49999 };
    const discord = fakeDiscord();
    const runtime = createGlabUnityHubRuntime({
      config, store, discord, portus: fakePortus(),
      breviarium: { listProjects: async () => ({}), projectOverview: async () => ({}) },
      notion: { query: async () => ({ items: [], nextCursor: null }), update: async () => ({ pageId: "p" }), create: async () => ({ pageId: "p" }) },
      actio: { aggregate: vi.fn(), sprintTasks: vi.fn(), findTask: vi.fn(), setStatus: vi.fn() } as never,
      praeforma: {} as never,
      github: {} as never,
      calliopeMaterials: { collect: async () => [] },
      calliopeWriter: { write: async () => null },
      log: () => undefined,
    });
    expect(await runtime.start()).toBe(49999);

    const tokens = new GlabUnityTokenService({ store, audit: store, clock: { now: () => new Date() }, glabGuildId: GLAB });
    const issued = tokens.issue({ discordUserId: USER, guildId: GLAB }, null);
    if (!issued.ok) throw new Error("issue failed");
    const tokenId = store.listByUser(USER)[0]!.id;
    const terminate = vi.fn();
    runtime.registry.add({ tokenId, discordUserId: USER, isSubscribed: () => false, pushEvent: () => undefined, terminate });

    vi.setSystemTime(new Date("2026-11-26T00:00:01.000Z"));
    tokens.revoke({ discordUserId: USER, guildId: GLAB }, issued.displayPrefix);
    await vi.advanceTimersByTimeAsync(REVOCATION_POLL_MS);
    expect(terminate).toHaveBeenCalledWith(4401, "token revoked");

    const leaver = vi.fn();
    runtime.registry.add({ tokenId: "other", discordUserId: "999999999999999999", isSubscribed: () => false, pushEvent: () => undefined, terminate: leaver });
    discord.leave?.("999999999999999999");
    expect(leaver).toHaveBeenCalledWith(4403, "left GLab guild");
    await runtime.stop();
  });
});
