import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeOkfTags } from "./okf.js";
import { knowledgeSearchRequestStore } from "./request-store.js";
import { knowledgeSearchTagStore } from "./tag-store.js";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); });
afterEach(() => db.close());

describe("knowledgeSearchRequestStore", () => {
  it("同じ要求鍵は 1 回だけ作り、再送では保存済みの要求を返す", () => {
    const store = knowledgeSearchRequestStore(db);
    const input = { requestKey: "slack:T:C:1", channel: "C", threadTs: "1", userId: "U", query: "unity", nowSec: 10 };
    const first = store.claim(input);
    const again = store.claim({ ...input, query: "別" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ created: false, request: { id: first.request.id, requestKey: "slack:T:C:1", query: "unity", state: "received" } });
  });
  it("終わった要求は状態を変えない", () => {
    const store = knowledgeSearchRequestStore(db);
    const { request } = store.claim({ requestKey: "k", channel: "C", threadTs: null, userId: null, query: "q", nowSec: 1 });
    store.finish(request.id, "answered", 3, null, 2);
    store.finish(request.id, "failed", 0, "x", 3);
    expect(db.prepare("SELECT state, hits, error FROM knowledge_search_requests").get()).toEqual({ state: "answered", hits: 3, error: null });
  });
});

describe("knowledgeSearchTagStore", () => {
  it("付与・失敗の記録と試行回数", () => {
    const store = knowledgeSearchTagStore(db);
    expect(store.get("d")).toBeNull();
    store.fail("d", "h1", 1);
    store.fail("d", "h1", 2);
    expect(store.get("d")).toEqual({ bodyHash: "h1", okf: null, attempts: 2 });
    store.fail("d", "h2", 3);
    expect(store.get("d")?.attempts).toBe(1);
    const okf = makeOkfTags({ type: "feature", title: "t", tags: ["vulkan"] });
    store.put("d", "h2", okf, 4);
    expect(store.get("d")).toEqual({ bodyHash: "h2", okf, attempts: 0 });
  });
});
