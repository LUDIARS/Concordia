/**
 * 拠点で起動したセッションを本社の Session フォーラムへ映す (SPEC-FED-SITE-SESSION-MIRROR)。
 * 本社側 (投稿を立てて台帳に載せる) と拠点側 (依頼・発言の転送・返信の注入) を確かめる。
 */
import { describe, expect, it, vi } from "vitest";
import { createHqSessionMirror } from "./hq-session-mirror.js";
import { createRemoteSessionSite, SITE_MIRROR_STARTER } from "./remote-session-site.js";
import { createRemoteThreadRegistry } from "./remote-thread-registry.js";
import { createSessionMirrorStore } from "./session-mirror-store.js";
import { mirrorTitleOf } from "./remote-session-wiring.js";
import { parseFederationFrame, serializeFederationFrame } from "./protocol.js";

const HQ_GUILD = "111111111111111111";
const HQ_POST = "555555555555555555";
const SITE_THREAD = "666666666666666666";
const quiet = { info: () => undefined, warn: () => undefined };

function memoryStore() {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
}

describe("HQ session mirror", () => {
  function hq(over: { opener?: ((input: { title: string; text: string }) => Promise<{ guildId: string; channelId: string }>) | null; status?: string } = {}) {
    const threads = createRemoteThreadRegistry(memoryStore(), "threads");
    const opener = over.opener === undefined ? vi.fn(async () => ({ guildId: HQ_GUILD, channelId: HQ_POST })) : over.opener;
    const mirror = createHqSessionMirror({
      threads,
      mirrors: createSessionMirrorStore(memoryStore(), "mirrors"),
      activeSiteName: (siteId) => (siteId === "melpot" && (over.status ?? "active") === "active" ? "MELPOT" : null),
      opener: () => opener,
      now: () => 1,
      log: quiet,
    });
    return { mirror, threads, opener };
  }
  const request = { session_id: "sess-9", title: "画面の修正", text: SITE_MIRROR_STARTER };

  it("opens a marked Session forum post and hands its thread to the site", async () => {
    const { mirror, threads, opener } = hq();
    expect(await mirror.open("melpot", request)).toEqual({ ok: true, guildId: HQ_GUILD, channelId: HQ_POST });
    expect(opener).toHaveBeenCalledWith({ title: "[M] 画面の修正", text: SITE_MIRROR_STARTER });
    // 拠点の発言 (egress) と人の返信 (ingress) がこの投稿で通る。
    expect(threads.find(HQ_POST)).toEqual({ guildId: HQ_GUILD, siteId: "melpot", at: 1 });
  });

  it("returns the same post when the site resends", async () => {
    const { mirror, opener } = hq();
    await mirror.open("melpot", request);
    expect(await mirror.open("melpot", request)).toMatchObject({ ok: true, channelId: HQ_POST });
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent requests for the same session", async () => {
    let release!: (post: { guildId: string; channelId: string }) => void;
    const opener = vi.fn(() => new Promise<{ guildId: string; channelId: string }>((resolve) => { release = resolve; }));
    const { mirror } = hq({ opener });
    const first = mirror.open("melpot", request);
    const second = mirror.open("melpot", request);
    expect(opener).toHaveBeenCalledTimes(1);
    release({ guildId: HQ_GUILD, channelId: HQ_POST });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, guildId: HQ_GUILD, channelId: HQ_POST },
      { ok: true, guildId: HQ_GUILD, channelId: HQ_POST },
    ]);
  });

  it("refuses revoked sites and reports a missing or failing forum", async () => {
    expect(await hq({ status: "revoked" }).mirror.open("melpot", request)).toEqual({ ok: false, error: "unknown or revoked site: melpot" });
    expect(await hq({ opener: null }).mirror.open("melpot", request)).toEqual({ ok: false, error: "HQ Session forum is unavailable" });
    const failing = hq({ opener: async () => { throw new Error("Missing Permissions"); } });
    expect((await failing.mirror.open("melpot", request)).ok).toBe(false);
    expect(failing.threads.find(HQ_POST)).toBeNull();
  });
});

describe("site session mirror", () => {
  function site(over: { source?: { channelId: string; title: string } | null; active?: boolean; open?: { ok: boolean; guildId?: string; channelId?: string; error?: string } } = {}) {
    const registry = createRemoteThreadRegistry(memoryStore(), "threads");
    const store = createSessionMirrorStore(memoryStore(), "mirrors");
    const requestOpen = vi.fn(async () => over.open ?? { ok: true, guildId: HQ_GUILD, channelId: HQ_POST });
    const inject = vi.fn();
    const egress: Array<{ guildId: string; channelId: string; text: string }> = [];
    const remote = createRemoteSessionSite({
      registry,
      buildPrompt: () => "",
      spawn: async () => ({ ok: true }),
      findSessionByChannel: () => null,
      channelOfSession: () => SITE_THREAD,
      inject,
      requestEgress: async (input) => { egress.push(input); return { ok: true }; },
      mirror: {
        store,
        sourceOf: () => (over.source === undefined ? { channelId: SITE_THREAD, title: "画面の修正" } : over.source),
        isActive: () => over.active ?? true,
        requestOpen,
        now: () => 1,
      },
      log: quiet,
    });
    return { remote, registry, store, requestOpen, inject, egress };
  }
  const ingress = (text: string) => ({
    type: "ingress", guild_id: HQ_GUILD, channel_id: HQ_POST, message_id: "777777777777777777",
    author_id: "333333333333333333", author_label: "operator", text, ts: 1,
  });

  it("mirrors a session started from the site's own forum, relays its replies and injects HQ replies", async () => {
    const { remote, store, requestOpen, inject, egress } = site();
    await remote.mirrorSession("sess-9");
    expect(requestOpen).toHaveBeenCalledWith({ sessionId: "sess-9", title: "画面の修正", text: SITE_MIRROR_STARTER });
    expect(store.find("sess-9")).toEqual({ guildId: HQ_GUILD, channelId: HQ_POST, at: 1 });

    await remote.relaySessionMessage({ sessionId: "sess-9", authorType: "assistant", content: "直しました" });
    expect(egress).toEqual([{ guildId: HQ_GUILD, channelId: HQ_POST, text: "直しました" }]);

    await remote.handleEvent(ingress("ありがとう"));
    expect(inject).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-9", text: "ありがとう" }));
  });

  it("does not mirror twice, nor sessions without a source thread or started from an HQ thread", async () => {
    const twice = site();
    await twice.remote.mirrorSession("sess-9");
    await twice.remote.mirrorSession("sess-9");
    expect(twice.requestOpen).toHaveBeenCalledTimes(1);

    const noSource = site({ source: null });
    await noSource.remote.mirrorSession("sess-9");
    expect(noSource.requestOpen).not.toHaveBeenCalled();

    const fromHq = site();
    fromHq.registry.record(SITE_THREAD, { guildId: HQ_GUILD, siteId: null, at: 1 });
    await fromHq.remote.mirrorSession("sess-9");
    expect(fromHq.requestOpen).not.toHaveBeenCalled();
  });

  it("coalesces concurrent mirror attempts at the site", async () => {
    let release!: (result: { ok: boolean; guildId: string; channelId: string }) => void;
    const requestOpen = vi.fn(() => new Promise<{ ok: boolean; guildId: string; channelId: string }>((resolve) => { release = resolve; }));
    const base = site();
    const remote = createRemoteSessionSite({
      registry: base.registry,
      buildPrompt: () => "",
      spawn: async () => ({ ok: true }),
      findSessionByChannel: () => null,
      channelOfSession: () => SITE_THREAD,
      inject: () => undefined,
      requestEgress: async () => ({ ok: true }),
      mirror: {
        store: base.store,
        sourceOf: () => ({ channelId: SITE_THREAD, title: "画面の修正" }),
        isActive: () => true,
        requestOpen,
        now: () => 1,
      },
      log: quiet,
    });
    const first = remote.mirrorSession("sess-9");
    const second = remote.mirrorSession("sess-9");
    expect(requestOpen).toHaveBeenCalledTimes(1);
    release({ ok: true, guildId: HQ_GUILD, channelId: HQ_POST });
    await Promise.all([first, second]);
    expect(base.store.find("sess-9")).toEqual({ guildId: HQ_GUILD, channelId: HQ_POST, at: 1 });
  });

  it("keeps nothing when HQ refuses, and tells HQ when the mirrored session has ended", async () => {
    const refused = site({ open: { ok: false, error: "HQ Session forum is unavailable" } });
    await refused.remote.mirrorSession("sess-9");
    expect(refused.store.find("sess-9")).toBeNull();
    expect(refused.registry.find(HQ_POST)).toBeNull();

    const ended = site({ active: false });
    await ended.remote.mirrorSession("sess-9");
    await ended.remote.handleEvent(ingress("まだいる?"));
    expect(ended.inject).not.toHaveBeenCalled();
    expect(ended.egress.at(-1)?.text).toContain("終了");
  });
});

describe("mirror title and frames", () => {
  it("titles the post by task, project, then folder", () => {
    expect(mirrorTitleOf({ id: "s", current_task: " 画面の修正 ", repo_path: "D:/work/example-repo", metadata: null })).toBe("画面の修正");
    expect(mirrorTitleOf({ id: "s", current_task: null, repo_path: "D:/work/example-repo", metadata: JSON.stringify({ project: "ExampleProject" }) })).toBe("ExampleProject");
    expect(mirrorTitleOf({ id: "s", current_task: null, repo_path: "D:\\work\\example-repo", metadata: "broken" })).toBe("example-repo");
    expect(mirrorTitleOf({ id: "s", metadata: null })).toBe("セッション");
  });

  it("sanitizes persisted mirror entries without treating special keys as object metadata", () => {
    let serialized = '{"bad":{"guildId":"g","channelId":"c","at":"invalid"},"__proto__":{"guildId":"g2","channelId":"c2","at":1}}';
    const store = createSessionMirrorStore(
      { get: () => serialized, set: (_key, value) => { serialized = value; } },
      "mirrors",
    );
    expect(store.find("bad")).toBeNull();
    expect(store.find("__proto__")).toEqual({ guildId: "g2", channelId: "c2", at: 1 });
    store.record("__proto__", { guildId: "g3", channelId: "c3", at: 2 });
    expect((JSON.parse(serialized) as Record<string, unknown>)["__proto__"]).toEqual({ guildId: "g3", channelId: "c3", at: 2 });
  });

  it("round-trips the mirror frames", () => {
    const req = parseFederationFrame(serializeFederationFrame({ type: "mirror-open-request", request_id: "r1", session_id: "sess-9", title: "t", text: "x" }));
    expect(req.ok && req.frame.type).toBe("mirror-open-request");
    const res = parseFederationFrame(serializeFederationFrame({ type: "mirror-open-result", request_id: "r1", ok: true, guild_id: HQ_GUILD, channel_id: HQ_POST }));
    expect(res.ok && res.frame.type).toBe("mirror-open-result");
  });
});
