import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { DiscordGatewayPool } from "./gateway-pool.js";

function fakeClient() {
  return {
    login: vi.fn(async () => "token"),
    destroy: vi.fn(),
    setMaxListeners: vi.fn(),
  } as unknown as Client;
}

describe("DiscordGatewayPool", () => {
  it("same token shares one client/login and destroys it after the last release", async () => {
    const client = fakeClient();
    const create = vi.fn(() => client);
    const pool = new DiscordGatewayPool(create);

    const head = pool.acquire("shared-token");
    const subsidiary = pool.acquire("shared-token");
    expect(head.client).toBe(subsidiary.client);
    expect(pool.connectionCount()).toBe(1);

    await Promise.all([head.login(), subsidiary.login()]);
    expect(client.login).toHaveBeenCalledOnce();

    await subsidiary.release();
    expect(client.destroy).not.toHaveBeenCalled();
    await head.release();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(pool.connectionCount()).toBe(0);
  });

  it("keeps different tokens on different physical clients", () => {
    const create = vi.fn(() => fakeClient());
    const pool = new DiscordGatewayPool(create);
    expect(pool.acquire("token-a").client).not.toBe(pool.acquire("token-b").client);
    expect(pool.connectionCount()).toBe(2);
  });
});
