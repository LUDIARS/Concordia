import { describe, expect, it, vi } from "vitest";
import { StatusPublisher, type StatusChannelPort } from "./publisher.js";
import type { StatusProjection } from "./policy.js";

function fixture() {
  const store = new Map<string, string>(); const posts = new Map<string, { content: string; nonce: string }>(); let id = 0;
  const config = { get: (key: string) => store.get(key) ?? null, set: (key: string, value: string) => { store.set(key, value); } };
  const port: StatusChannelPort = {
    send: vi.fn(async (content, nonce) => { const key = String(++id); posts.set(key, { content, nonce }); return key; }),
    edit: vi.fn(async (key, content) => { posts.get(key)!.content = content; }),
    remove: vi.fn(async (key) => { posts.delete(key); }),
    findNonce: vi.fn(async (nonce) => [...posts].find(([, post]) => post.nonce === nonce)?.[0] ?? null),
  };
  return { config, port, posts, store };
}
function projection(state: "up" | "down" = "up"): StatusProjection {
  const service = { siteId: "self", code: "cc", name: "Concordia", project: "Cc", repository: null, state, checkedAt: 100 };
  return { sites: [{ id: "self", name: "HQ", self: true, connected: true, stale: false }], services: [service], running: state === "up" ? [service] : [] };
}
describe("status channel delivery ownership", () => {
  it("recreates a summary after Discord confirms its deletion, preserving the transition baseline", async () => {
    const f = fixture(); const publisher = new StatusPublisher(f.config, f.port);
    await publisher.refresh(projection(), "hq");
    f.posts.clear(); f.port.edit = vi.fn().mockResolvedValue(false);
    await publisher.refresh(projection(), "hq");
    expect(f.posts.size).toBe(1);
    expect(f.port.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.store.get("service_status_ledger")!).history).toEqual([]);
  });
  it("updates pages and persists the baseline through restart without duplicate transitions", async () => {
    const f = fixture(); const publisher = new StatusPublisher(f.config, f.port);
    await publisher.refresh(projection(), "hq"); await publisher.refresh(projection("down"), "hq");
    expect(f.posts.size).toBe(2);
    await new StatusPublisher(f.config, f.port).refresh(projection("down"), "hq");
    expect(f.posts.size).toBe(2);
    expect([...f.posts.values()].some((post) => post.content.includes("稼働 → 停止/異常"))).toBe(true);
  });
  it("removes owned history and pages before publishing a revoked scope", async () => {
    const f = fixture(); const publisher = new StatusPublisher(f.config, f.port);
    await publisher.refresh(projection(), "all"); await publisher.refresh(projection("down"), "all");
    await publisher.refresh({ sites: [], services: [], running: [] }, "none");
    expect(f.port.remove).toHaveBeenCalledTimes(2);
    expect([...f.posts.values()].every((post) => !post.content.includes("Concordia"))).toBe(true);
  });
  it("reconciles an accepted send with lost response instead of resending", async () => {
    const f = fixture(); const normalSend = f.port.send;
    f.port.send = vi.fn(async (content, nonce) => { await normalSend(content, nonce); throw new Error("connection lost"); });
    await expect(new StatusPublisher(f.config, f.port).refresh(projection(), "hq")).rejects.toThrow("connection lost");
    f.port.send = normalSend;
    await new StatusPublisher(f.config, f.port).refresh(projection(), "hq");
    expect(f.posts.size).toBe(1); expect(normalSend).toHaveBeenCalledTimes(1);
  });
  it("keeps unknown send pending and does not automatically retry", async () => {
    const f = fixture(); f.port.send = vi.fn().mockRejectedValue(new Error("timeout"));
    const publisher = new StatusPublisher(f.config, f.port);
    await expect(publisher.refresh(projection(), "hq")).rejects.toThrow("timeout");
    await expect(publisher.refresh(projection(), "hq")).rejects.toThrow("manual_reconciliation_required");
    expect(f.port.send).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed persisted delivery state before using message ids", async () => {
    const f = fixture();
    f.store.set("service_status_ledger", JSON.stringify({ pages: ["not-an-id"], history: [], previous: null, scope: "hq" }));
    await expect(new StatusPublisher(f.config, f.port).refresh(projection(), "hq")).rejects.toThrow("invalid_service_status_ledger");
    expect(f.port.edit).not.toHaveBeenCalled(); expect(f.port.remove).not.toHaveBeenCalled();
  });
  it("reconciles a lost history response and advances its baseline without duplicating the event", async () => {
    const f = fixture(); const publisher = new StatusPublisher(f.config, f.port);
    await publisher.refresh(projection(), "hq");
    const send = f.port.send;
    f.port.send = vi.fn(async (content, nonce) => { await send(content, nonce); throw new Error("history response lost"); });
    await expect(publisher.refresh(projection("down"), "hq")).rejects.toThrow("history response lost");
    f.port.send = send;
    await new StatusPublisher(f.config, f.port).refresh(projection("down"), "hq");
    expect(f.posts.size).toBe(2); expect(send).toHaveBeenCalledTimes(2);
  });
  it("renders every service across bounded pages without truncating the last service", async () => {
    const f = fixture(); const data = projection(); data.running = data.services = Array.from({ length: 200 }, (_, index) => ({ ...data.services[0]!, code: `service-${index}`, name: `Service ${index}` }));
    await new StatusPublisher(f.config, f.port).refresh(data, "hq");
    expect(f.posts.size).toBeGreaterThan(1);
    expect([...f.posts.values()].every((post) => post.content.length <= 1800)).toBe(true);
    expect([...f.posts.values()].some((post) => post.content.includes("service-199"))).toBe(true);
  });
  it("an outage replaces the running claim, and stop prevents side effects", async () => {
    const f = fixture(); const publisher = new StatusPublisher(f.config, f.port);
    await publisher.refresh(projection(), "hq"); await publisher.refresh(null, "hq");
    expect([...f.posts.values()][0]!.content).toContain("以前の稼働状態は未確認");
    await publisher.refresh(projection(), "hq", () => true);
    expect([...f.posts.values()][0]!.content).toContain("以前の稼働状態は未確認");
  });
});
