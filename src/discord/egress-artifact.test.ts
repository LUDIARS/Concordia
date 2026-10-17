import { describe, expect, it, vi } from "vitest";
import type { ConcordiaEvent } from "../events.js";
import type { ChatMessageRelay } from "../platform/chat-read-model.js";
import { buildAttachFiles } from "./attachment-files.js";
import { handleEvent, type EgressDeps } from "./egress.js";

// Concordia uses isolate:false to avoid native DB worker teardown failures.
// Reload egress before installing its attachment mock: another test file may
// already have cached egress with the real file loader in the shared worker.
vi.hoisted(() => vi.resetModules());

vi.mock("./attachment-files.js", () => ({
  DISCORD_ATTACH_MAX_BYTES: 24 * 1024 * 1024,
  buildAttachFiles: vi.fn(),
}));

/** Real egress control flow; only external I/O ports are replaced. */
function fixture(change: Partial<ChatMessageRelay> = {}) {
  const row: ChatMessageRelay = {
    id: 42, channel: "system", sessionId: "s1", authorLabel: "Assistant",
    text: "Requested models", metadata: {
      discord_channel_id: "own-channel", attachment_paths: ["/workspace/models.zip"],
    }, ...change,
  };
  const surface = { channel_id: "own-channel", status: "active" };
  const session = { sessionId: "s1", status: "active", endedAt: null, provider: "codex" };
  const send = vi.fn(async () => ({ id: "discord-42" }));
  const put = vi.fn();
  const getForSession = vi.fn(async () => ({ id: "own-webhook" }));
  const getForChannel = vi.fn();
  const files = [{ attachment: Buffer.from("model"), name: "models.zip" }];
  vi.mocked(buildAttachFiles).mockReset().mockResolvedValue(files);
  const deps = {
    relayOutputPolicy: () => ({ intermediate: false, injectTranscript: false }),
    layout: { metaChannels: { system: "meta-system", 報告: "meta-report" } },
    readModel: { getChatMessage: () => row, getSessionRelayState: () => session },
    sessionChannelsRepo: { findBySessionId: () => surface },
    webhooks: { getForSession, getForChannel, send }, messageMap: { put },
    isReadyPrivateChannel: () => true,
    resolveWorkspaceRoots: () => ["/workspace"], log: { warn: vi.fn() },
  } as unknown as EgressDeps;
  const event: Extract<ConcordiaEvent, { type: "chat.posted" }> = {
    type: "chat.posted", message_id: 42, channel: row.channel,
    session_id: row.sessionId, author_label: "Assistant", ts: 1, is_actionable: false,
  };
  return { deps, event, surface, session, send, put, getForSession, getForChannel, files };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("artifact egress under final-only output (CC-EXPLICIT-ARTIFACT-01)", () => {
  it("sends files and caption only to the session webhook and records delivery", async () => {
    const f = fixture();
    handleEvent(f.deps, f.event);
    await flush();
    expect(f.getForSession).toHaveBeenCalledWith("s1");
    expect(f.getForChannel).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith({ id: "own-webhook" }, expect.objectContaining({
      content: "Requested models", files: f.files, allowedMentions: { parse: [] },
    }));
    expect(f.put).toHaveBeenCalledWith("discord-42", 42);
  });

  it.each([
    { metadata: {} },
    { metadata: { attachment_paths: ["/workspace/models.zip"] } },
    { metadata: { discord_channel_id: "own-channel", attachment_paths: [] } },
    { metadata: { discord_channel_id: "another-channel", attachment_paths: ["/workspace/models.zip"] } },
    { metadata: { discord_channel_id: "own-channel", attachment_paths: ["/workspace/models.zip"], source: "discord" } },
    { channel: "報告" },
    { channel: "consultation" },
  ] satisfies Partial<ChatMessageRelay>[])("does not turn hidden or differently routed chat into artifact delivery: %j", async (change) => {
    const f = fixture(change);
    handleEvent(f.deps, f.event);
    await flush();
    expect(buildAttachFiles).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("logs a dropped meta-channel post instead of discarding it silently (Actio 84c50291)", async () => {
    const meta = fixture({ channel: "consultation" });
    handleEvent(meta.deps, meta.event);
    await flush();
    expect(meta.send).not.toHaveBeenCalled();
    expect(meta.deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("channel=consultation"));

    const ownChatter = fixture({ metadata: {} });
    handleEvent(ownChatter.deps, ownChatter.event);
    await flush();
    expect(ownChatter.deps.log.warn).not.toHaveBeenCalled();
  });

  it("does not leak a caption when all files are rejected, missing or oversized", async () => {
    const f = fixture();
    vi.mocked(buildAttachFiles).mockResolvedValue([]);
    handleEvent(f.deps, f.event);
    await flush();
    expect(f.getForSession).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("requires active session and surface before file I/O", async () => {
    const f = fixture();
    f.session.status = "ended";
    handleEvent(f.deps, f.event);
    await flush();
    expect(buildAttachFiles).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["session", "surface", "destination"] as const)("rechecks %s after file I/O", async (changed) => {
    const f = fixture();
    vi.mocked(buildAttachFiles).mockImplementation(async () => {
      if (changed === "session") f.session.status = "lost";
      if (changed === "surface") f.surface.status = "ended";
      if (changed === "destination") f.surface.channel_id = "replacement-channel";
      return f.files;
    });
    handleEvent(f.deps, f.event);
    await flush();
    expect(f.getForSession).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not claim delivery when the webhook returns no result", async () => {
    const f = fixture();
    f.deps.webhooks.send = vi.fn(async () => null);
    handleEvent(f.deps, f.event);
    await flush();
    expect(f.put).not.toHaveBeenCalled();
    expect(f.deps.log.warn).toHaveBeenCalled();
  });

  it("does not send when the destination changes during webhook lookup", async () => {
    const f = fixture();
    f.getForSession.mockImplementation(async () => {
      f.surface.channel_id = "replacement-channel";
      return { id: "replacement-webhook" };
    });
    handleEvent(f.deps, f.event);
    await flush();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });
});
