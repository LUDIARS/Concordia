import { describe, expect, it, vi } from "vitest";
import { postDelegationThreadLink } from "./delegation-thread-link.js";

function makeDeps(overrides: { channels?: Record<string, string> } = {}) {
  const channels = overrides.channels ?? { parent: "100", child: "200" };
  const config = new Map<string, string>();
  const post = vi.fn(async () => undefined);
  return {
    post,
    config,
    deps: {
      guildId: "9",
      sessionChannelsRepo: {
        findBySessionId: (sessionId: string) =>
          channels[sessionId] ? { channel_id: channels[sessionId] } : null,
      },
      configRepo: {
        get: (key: string) => config.get(key) ?? "",
        set: (key: string, value: string) => { config.set(key, value); },
      },
      post,
      log: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof postDelegationThreadLink>[0],
  };
}

const input = {
  runId: "run-1",
  status: "running",
  parentSessionId: "parent",
  childSessionId: "child",
  label: "実装委託",
};

describe("postDelegationThreadLink", () => {
  it("起動できた委託のスレッドリンクを親の面へ貼る", async () => {
    const { deps, post } = makeDeps();
    expect(await postDelegationThreadLink(deps, input)).toBe(true);
    expect(post).toHaveBeenCalledWith("100", expect.stringContaining("https://discord.com/channels/9/200"));
    expect(post).toHaveBeenCalledWith("100", expect.stringContaining("実装委託"));
  });

  it("同じ run では二度貼らない", async () => {
    const { deps, post } = makeDeps();
    await postDelegationThreadLink(deps, input);
    expect(await postDelegationThreadLink(deps, { ...input, status: "running" })).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("起動前の status では貼らない", async () => {
    const { deps, post } = makeDeps();
    expect(await postDelegationThreadLink(deps, { ...input, status: "queued" })).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("子の面がまだ無ければ貼らず、後で貼り直せるようにする", async () => {
    const { deps, post } = makeDeps({ channels: { parent: "100" } });
    expect(await postDelegationThreadLink(deps, input)).toBe(false);
    expect(post).not.toHaveBeenCalled();
    // 面ができた後の再試行を塞がないこと (投稿済みフラグを立てていない)。
    const withChild = makeDeps();
    expect(await postDelegationThreadLink(withChild.deps, input)).toBe(true);
  });
});
