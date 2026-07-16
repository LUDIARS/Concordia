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
  it("sanitizes, truncates, and deterministically retries names", () => {
    const names = buildSessionChannelNames("ABCDEF12-3456-7890", " 日本語 Hello___WORLD " + "x".repeat(100));
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/^cc-run-abcdef12-hello-world-x+$/);
    expect(names[1]).toContain("cc-run-abcdef12-345-");
    expect(names[2]).toMatch(/^cc-run-abcdef12-345-[a-f0-9]{6}-/);
    expect(names.every((name) => name.length <= 80 && /^[a-z0-9-]+$/.test(name))).toBe(true);
    expect(buildSessionChannelNames("s1", "日本語")[0]).toBe("cc-run-s1-session");
    expect(buildSessionChannelNames("session-1", "task")[0]).toBe("cc-run-session-task");
  });

  it("coalesces concurrent ensure calls into one public channel", async () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb(), () => 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = vi.fn(async () => {
      await gate;
      return { channel: { id: "C1", name: "cc-run-s1-task" } };
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
      .mockResolvedValueOnce({ channel: { id: "C2", name: "cc-run-abcdef12-345-task" } });
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
    const create = vi.fn(async () => ({ channel: { id: "C1", name: "cc-run-s1-task" } }));
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
});
