import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../db/schema.js";
import { SqlitePublicationStore } from "../db/ai-note-publication.js";
import { destinationKey, type Article, type Destination, type SendResult } from "./model.js";
import { PublicationService } from "./publication-service.js";

const article: Article = { page_id: "3d839cbfbab98174bb4ef6787481efc9", title: "記事",
  url: "https://app.notion.com/p/3d839cbfbab98174bb4ef6787481efc9" };
const target: Destination = { kind: "discord-channel", guild_id: "111111111111111111", channel_id: "222222222222222222" };
const receipt = { message_id: "333333333333333333", channel_id: target.channel_id, message_url: "https://discord.com/channels/1/2/3" };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const db = new Database(":memory:"); databases.push(db);
  MIGRATIONS.find(migration => migration.name === "ai-note-publication")!.up(db);
  const store = new SqlitePublicationStore(db);
  store.replaceTargets([target]);
  let now = 1_000; let attempt = 0;
  const send = vi.fn<() => Promise<SendResult>>().mockResolvedValue({ status: "sent", receipt });
  const verify = vi.fn().mockResolvedValue(receipt);
  const service = new PublicationService(store, { send, verify }, () => now, () => `attempt-${++attempt}`);
  return { store, service, send, verify, db, advance: (ms: number) => { now += ms; } };
}

describe("AI note publication state", () => {
  it("recovers one failed destination without repeating an already delivered notice", async () => {
    const { store, service, send } = setup();
    const second: Destination = { ...target, channel_id: "444444444444444444" };
    store.replaceTargets([target, second]);
    send.mockResolvedValueOnce({ status: "sent", receipt }).mockResolvedValueOnce({ status: "failed", error_code: "http_403" });
    const first = await service.publish(article);
    expect(first.map(row => row.status)).toEqual(["sent", "failed"]);
    await service.publish(article);
    expect(send).toHaveBeenCalledTimes(2);
    await service.retry(article.page_id, destinationKey(second));
    expect(send).toHaveBeenCalledTimes(3);
    expect(service.list(article.page_id).map(row => row.status)).toEqual(["sent", "sent"]);
  });

  it("retains unknown state when remote verification finds no matching message", async () => {
    const { service, send, verify } = setup();
    send.mockResolvedValueOnce({ status: "unknown", error_code: "transport_unavailable" });
    verify.mockResolvedValueOnce(null);
    await service.publish(article);
    await expect(service.reconcile(article.page_id, destinationKey(target), receipt.message_id, receipt.channel_id)).rejects.toThrow("receipt_not_verified");
    expect(service.list(article.page_id)[0].status).toBe("unknown");
  });

  it("serializes concurrent requests and retains receipts across service instances", async () => {
    const { store, service, send, db } = setup();
    await Promise.all([service.publish(article), service.publish(article)]);
    expect(send).toHaveBeenCalledTimes(1);
    const reopened = new PublicationService(new SqlitePublicationStore(db), { send, verify: async () => null }, () => 2_000, () => "new-attempt");
    expect((await reopened.publish({ ...article, title: "表題の修正" }))[0]).toMatchObject({ status: "sent", article: { title: "記事" }, receipt });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.list(article.page_id)).toHaveLength(1);
  });

  it("sends only newly added destinations and keeps physical identity when forum tags change", async () => {
    const { store, service, send } = setup();
    await service.publish(article);
    store.replaceTargets([target, { kind: "discord-forum", guild_id: target.guild_id, channel_id: "444444444444444444", applied_tags: [] }]);
    await service.publish(article);
    expect(send).toHaveBeenCalledTimes(2);
    store.replaceTargets([{ kind: "discord-forum", guild_id: target.guild_id, channel_id: "444444444444444444", applied_tags: ["555555555555555555"] }]);
    await service.publish(article);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry failures implicitly or repeat successful destinations during explicit retry", async () => {
    const { service, send } = setup();
    send.mockResolvedValueOnce({ status: "failed", error_code: "http_403" });
    expect((await service.publish(article))[0].status).toBe("failed");
    await service.publish(article);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await service.retry(article.page_id, destinationKey(target))).status).toBe("sent");
    await expect(service.retry(article.page_id, destinationKey(target))).rejects.toThrow("not_failed");
  });

  it("keeps ambiguous delivery blocked until the remote message is verified", async () => {
    const { service, send } = setup();
    send.mockResolvedValueOnce({ status: "unknown", error_code: "transport_unavailable" });
    await service.publish(article);
    await expect(service.retry(article.page_id, destinationKey(target))).rejects.toThrow("not_failed");
    expect((await service.reconcile(article.page_id, destinationKey(target), receipt.message_id, receipt.channel_id)).status).toBe("sent");
    await service.publish(article);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("records interrupted sends as unknown and rejects late completion after human resolution", () => {
    const { store, service, advance } = setup();
    store.enqueue(article, [target], 1_000);
    expect(store.claim(article.page_id, destinationKey(target), "pending", "interrupted", 1_000)).toBe(true);
    advance(120_001);
    expect(service.list(article.page_id)[0].status).toBe("unknown");
    service.confirmAbsent(article.page_id, destinationKey(target), "人間が投稿先の履歴を確認し未投稿と判断した");
    expect(store.claim(article.page_id, destinationKey(target), "failed", "new-attempt", 121_001)).toBe(true);
    store.finish(article.page_id, destinationKey(target), "interrupted", { status: "sent", receipt }, 121_002);
    expect(store.find(article.page_id, destinationKey(target))).toMatchObject({ status: "sending", attempt_id: "new-attempt", resolution: "人間が投稿先の履歴を確認し未投稿と判断した" });
  });

  it("creates no publication when no destination is configured", async () => {
    const { store, service, send } = setup(); store.replaceTargets([]);
    await expect(service.publish(article)).rejects.toThrow("no_targets");
    expect(store.list(article.page_id)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
