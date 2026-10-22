import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeSlackSessionChannelsRepo } from "./session-channels-repo.js";
import {
  buildSessionChannelNames,
  SlackSessionChannelProvisioner,
  type SlackSessionProvisioningClient,
} from "./session-channel-provisioner.js";

function makeClient(create: SlackSessionProvisioningClient["conversations"]["create"]): SlackSessionProvisioningClient {
  return {
    conversations: {
      create,
      list: vi.fn(async () => ({ channels: [] })),
      setTopic: vi.fn(async () => ({})),
      setPurpose: vi.fn(async () => ({})),
      rename: vi.fn(async (args: { channel: string; name: string }) => ({ channel: { id: args.channel, name: args.name } })),
    },
    chat: { postMessage: vi.fn(async () => ({ ts: "100.1" })) },
  };
}

const describeSession = () => ({
  title: "設計書から Slack Sessions を実装",
  topic: "active · codex · task",
  header: { text: "header" },
});

describe("Slack session channel provisioning", () => {
  it("names the channel cc-<title> like the Discord channel body, then adds the session id and a hash", () => {
    const names = buildSessionChannelNames("ABCDEF12-3456-7890", " 日本語 Hello___WORLD [Slack] " + "x".repeat(100));
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/^cc-日本語-hello-world-slack-x+$/);
    expect(names[1]).toMatch(/^cc-日本語-hello-world-slack-x+-abcdef12-345$/);
    expect(names[2]).toMatch(/^cc-日本語-hello-world-slack-x+-abcdef12-345-[a-f0-9]{6}$/);
    expect(names.every((name) => name.length <= 80 && /^cc-[a-z0-9぀-ヿ㐀-鿿-]+$/.test(name))).toBe(true);
    expect(buildSessionChannelNames("s1", "設計書から実装")[0]).toBe("cc-設計書から実装");
    expect(buildSessionChannelNames("session-1", "task")[0]).toBe("cc-task");
  });

  it("falls back to the session id when there is no title", () => {
    expect(buildSessionChannelNames("s1", null)[0]).toBe("cc-s1-session");
    expect(buildSessionChannelNames("s1", "!!!")[0]).toBe("cc-s1-session");
  });

  it("coalesces concurrent ensure calls into one public channel", async () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb(), () => 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = vi.fn(async () => {
      await gate;
      return { channel: { id: "C1", name: "cc-task" } };
    });
    const client = makeClient(create);
    const provisioner = new SlackSessionChannelProvisioner({ repo, client, describeSession });

    const first = provisioner.ensure("s1");
    const second = provisioner.ensure("s1");
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.channel_id).toBe("C1");
    expect(b.channel_id).toBe("C1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ is_private: false }));
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("uses the longer id after name_taken without falling back to a thread", async () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb());
    const create = vi.fn()
      .mockRejectedValueOnce({ data: { error: "name_taken" } })
      .mockResolvedValueOnce({ channel: { id: "C2", name: "cc-設計書から-slack-sessions-を実装-abcdef12-345" } });
    const client = makeClient(create);
    const provisioner = new SlackSessionChannelProvisioner({ repo, client, describeSession });

    await expect(provisioner.ensure("abcdef12-3456")).resolves.toMatchObject({ channel_id: "C2" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries persistence before creating another channel after a DB failure", async () => {
    const baseRepo = makeSlackSessionChannelsRepo(makeTestDb());
    let shouldFail = true;
    const repo = {
      ...baseRepo,
      upsert(input: Parameters<typeof baseRepo.upsert>[0]) {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("db unavailable");
        }
        baseRepo.upsert(input);
      },
    };
    const create = vi.fn(async () => ({ channel: { id: "C1", name: "cc-task" } }));
    const client = makeClient(create);
    const error = vi.fn();
    const provisioner = new SlackSessionChannelProvisioner({
      repo,
      client,
      describeSession,
      log: { info: vi.fn(), warn: vi.fn(), error },
    });

    await expect(provisioner.ensure("s1")).rejects.toThrow("db unavailable");
    await expect(provisioner.ensure("s1")).resolves.toMatchObject({ channel_id: "C1" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("mapping persistence failed"));
  });

  it("renames the channel to the new title and moves on when the name is taken", async () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb());
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "cc-s1-session" });
    const client = makeClient(vi.fn());
    const rename = vi.mocked(client.conversations.rename)
      .mockRejectedValueOnce({ data: { error: "name_taken" } });
    const provisioner = new SlackSessionChannelProvisioner({ repo, client, describeSession });

    await provisioner.rename("s1", "録画と感想");

    expect(rename.mock.calls.map(([args]) => args.name)).toEqual(["cc-録画と感想", "cc-録画と感想-s1"]);
    expect(repo.findBySessionId("s1")?.channel_name).toBe("cc-録画と感想-s1");
    await provisioner.rename("s1", "録画と感想");
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("does not rename an archived channel and keeps the name when Slack refuses", async () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb());
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "cc-s1-session" });
    const client = makeClient(vi.fn());
    vi.mocked(client.conversations.rename).mockRejectedValueOnce({ data: { error: "missing_scope" } });
    const warn = vi.fn();
    const provisioner = new SlackSessionChannelProvisioner({ repo, client, describeSession, log: { info: vi.fn(), warn, error: vi.fn() } });

    await provisioner.rename("s1", "題");
    expect(repo.findBySessionId("s1")?.channel_name).toBe("cc-s1-session");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));

    repo.markArchived("s1", 5);
    await provisioner.rename("s1", "別の題");
    expect(client.conversations.rename).toHaveBeenCalledTimes(1);
  });
});
