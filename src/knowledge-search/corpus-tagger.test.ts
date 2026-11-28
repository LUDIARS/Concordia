import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCorpus } from "./corpus.js";
import { knowledgeSearchTagStore } from "./tag-store.js";
import { TAGGER_LIMITS, attachTags, needsTagging, tagNextDocuments } from "./tagger.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE knowledge_flow_articles (id INTEGER PRIMARY KEY, url TEXT, state TEXT, received_at TEXT);
    CREATE TABLE knowledge_flow_jobs (article_id INTEGER PRIMARY KEY, report TEXT);
    CREATE TABLE knowledge_flow_documents (article_id INTEGER, kind TEXT, markdown TEXT, PRIMARY KEY(article_id, kind));
    CREATE TABLE notion_map_pages (page_id TEXT, title TEXT, url TEXT, path TEXT, summary TEXT, keywords TEXT);
    CREATE TABLE chat_knowledge_chunks (id INTEGER PRIMARY KEY, source_kind TEXT, doc_key TEXT, seq INTEGER, title TEXT, url TEXT, body TEXT);`);
  db.prepare("INSERT INTO knowledge_flow_articles VALUES (1, 'https://example.org/a', 'adopted', '')").run();
  db.prepare("INSERT INTO knowledge_flow_jobs VALUES (1, ?)").run(JSON.stringify({ evaluation: { category: "開発", tags: ["Unity", "ECS"] } }));
  db.prepare("INSERT INTO knowledge_flow_documents VALUES (1, 'adopt', '# ECS 入門\n本文')").run();
  db.prepare("INSERT INTO notion_map_pages VALUES ('p1', 'ナレッジ', 'https://notion.so/p1', 'KB / ナレッジ', '要約', '[\"shader\"]')").run();
  db.prepare("INSERT INTO notion_map_pages VALUES ('p2', '未解析', null, null, null, '[]')").run();
  const chunk = db.prepare("INSERT INTO chat_knowledge_chunks (source_kind, doc_key, seq, title, url, body) VALUES (?, ?, ?, ?, ?, ?)");
  chunk.run("ludiars", "repo:Cc:README.md", 0, "Cc README", null, "前半");
  chunk.run("ludiars", "repo:Cc:README.md", 1, "Cc README", null, "後半");
  chunk.run("notion", "notion:x", 0, "重複", null, "notion の断片は記事マップと重なるので除く");
});
afterEach(() => db.close());

describe("loadCorpus", () => {
  it("3 つの出典を読み、出典のタグを OKF にする", () => {
    const docs = loadCorpus(db);
    expect(docs.map((d) => d.docKey)).toEqual(["knowledge-flow:1:adopt", "notion:p1", "notion:p2", "ludiars:repo:Cc:README.md"]);
    expect(docs[0]).toMatchObject({ title: "ECS 入門", url: "https://example.org/a", intrinsicOkf: { type: "article", domain: "開発", tags: ["unity", "ecs", "開発"] } });
    expect(docs[1].intrinsicOkf?.tags).toEqual(["shader"]);
    expect(docs[2].intrinsicOkf).toBeNull();
    expect(docs[3].body).toBe("前半\n後半");
  });
  it("表が無ければ空", () => {
    expect(loadCorpus(new Database(":memory:"))).toEqual([]);
  });
});

describe("tagger", () => {
  it("出典のタグが無い文書だけを LLM で付け、本文が同じなら付け直さない", async () => {
    const store = knowledgeSearchTagStore(db);
    const runner = vi.fn(async () => ({ ok: true, stdout: '{"type":"feature","tags":["Hono"],"roles":["プログラマ"]}', stderr: "" }));
    const deps = { loadDocs: () => loadCorpus(db), store, runner, nowSec: () => 1 };
    expect(await tagNextDocuments(deps)).toBe(2);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][1]).toEqual({ model: TAGGER_LIMITS.model, timeoutMs: TAGGER_LIMITS.timeoutMs, conversationOnly: true });
    expect(await tagNextDocuments(deps)).toBe(0);
    const tagged = attachTags(loadCorpus(db), store);
    expect(tagged.find((d) => d.docKey === "ludiars:repo:Cc:README.md")?.okf?.tags).toEqual(["hono"]);
    expect(tagged.find((d) => d.docKey === "notion:p1")?.okf?.tags).toEqual(["shader"]);
  });
  it("失敗は上限まで再挑戦し、本文が変われば付け直す", async () => {
    const store = knowledgeSearchTagStore(db);
    const runner = vi.fn(async () => ({ ok: false, stdout: "", stderr: "timeout" }));
    const deps = { loadDocs: () => loadCorpus(db), store, runner, nowSec: () => 1 };
    for (let i = 0; i < TAGGER_LIMITS.maxAttempts + 1; i += 1) await tagNextDocuments(deps);
    const readme = loadCorpus(db).find((d) => d.docKey === "ludiars:repo:Cc:README.md")!;
    expect(needsTagging(readme, store)).toBe(false);
    db.prepare("UPDATE chat_knowledge_chunks SET body = '更新' WHERE seq = 1").run();
    expect(needsTagging(loadCorpus(db).find((d) => d.docKey === readme.docKey)!, store)).toBe(true);
  });
});
