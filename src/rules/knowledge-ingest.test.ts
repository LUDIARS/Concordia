import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatKnowledgeRepo } from "../db/chat-knowledge-repo.js";
import { applyMigrations } from "../db/schema.js";
import { KNOWLEDGE_REFRESH_SEC, KNOWLEDGE_REFRESH_SEC_BY_KIND, createKnowledgeIngest, redactReason } from "./knowledge-ingest.js";
import type { KnowledgeCollector, KnowledgeDoc } from "./knowledge-types.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

const TOKEN = "secret-example-token-0000";

function doc(key: string, text: string, scope: "hq" | "public" = "hq"): KnowledgeDoc {
  return { docType: "notion-page", docKey: key, title: `title ${key}`, url: `https://example.test/${key}`, repo: null, path: null, scope, text, sourceUpdatedAt: 1 };
}

function harness(collectors: Partial<Record<"ludiars" | "revisor" | "notion", KnowledgeCollector>>, terms: string[] = []) {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const repo = new ChatKnowledgeRepo(db);
  const clock = { ms: Date.parse("2026-10-18T00:00:00Z") };
  const ingest = createKnowledgeIngest({
    repo, collectors, confidentialTerms: async () => terms, secrets: () => [TOKEN], nowMs: () => clock.ms,
  });
  return { repo, ingest, clock };
}

describe("knowledge ingest", () => {
  it("stores chunks with source and scope, and replaces a kind on a full refresh", async () => {
    let docs = [doc("notion:a", "alpha body"), doc("notion:b", "beta body")];
    const h = harness({ notion: async () => ({ docs, full: true, cursor: "c1" }) });
    expect(await h.ingest.refresh(["notion"])).toMatchObject([{ kind: "notion", status: "refreshed", docs: 2 }]);
    expect(h.repo.list({ publicOnly: false }).map((c) => [c.doc_key, c.scope, c.url])).toEqual([
      ["notion:a", "hq", "https://example.test/notion:a"],
      ["notion:b", "hq", "https://example.test/notion:b"],
    ]);
    docs = [doc("notion:b", "beta v2")];
    await h.ingest.refresh(["notion"]);
    expect(h.repo.list({ publicOnly: false }).map((c) => c.body)).toEqual(["beta v2"]);
  });

  it("replaces only the delivered documents on an incremental refresh", async () => {
    const collector = vi.fn<KnowledgeCollector>()
      .mockResolvedValueOnce({ docs: [doc("notion:a", "a1"), doc("notion:b", "b1")], full: true, cursor: "c1" })
      .mockResolvedValueOnce({ docs: [doc("notion:b", "b2")], full: false, cursor: "c2" });
    const h = harness({ notion: collector });
    await h.ingest.tick();
    h.clock.ms += (KNOWLEDGE_REFRESH_SEC_BY_KIND.notion + 1) * 1000;
    await h.ingest.tick();
    expect(collector.mock.calls[1]![0]).toEqual({ cursor: "c1", full: false });
    expect(h.repo.list({ publicOnly: false }).map((c) => c.body)).toEqual(["a1", "b2"]);
    expect(h.repo.source("notion")?.cursor).toBe("c2");
  });

  it("refreshes the Notion map weekly and the others daily", async () => {
    const notion = vi.fn<KnowledgeCollector>(async () => ({ docs: [doc("notion:a", "a")], full: false, cursor: null }));
    const ludiars = vi.fn<KnowledgeCollector>(async () => ({ docs: [doc("project:Ex", "p", "public")], full: true, cursor: null }));
    const h = harness({ notion, ludiars });
    await h.ingest.tick();
    h.clock.ms += (KNOWLEDGE_REFRESH_SEC + 1) * 1000;
    await h.ingest.tick();
    expect(ludiars).toHaveBeenCalledTimes(2);
    expect(notion).toHaveBeenCalledTimes(1);
    expect(KNOWLEDGE_REFRESH_SEC_BY_KIND.notion).toBe(7 * KNOWLEDGE_REFRESH_SEC);
  });

  it("drops documents that are no longer in the retained set (pages that left the Notion map)", async () => {
    const collector = vi.fn<KnowledgeCollector>()
      .mockResolvedValueOnce({ docs: [doc("notion:a", "a1"), doc("notion:b", "b1")], full: false, cursor: null })
      .mockResolvedValueOnce({ docs: [], full: false, cursor: null, retainDocKeys: ["notion:b"] });
    const h = harness({ notion: collector });
    await h.ingest.refresh(["notion"]);
    await h.ingest.refresh(["notion"]);
    expect(h.repo.list({ publicOnly: false }).map((c) => c.doc_key)).toEqual(["notion:b"]);
  });

  it("keeps the previous chunks and records the reason when a refresh fails", async () => {
    const collector = vi.fn<KnowledgeCollector>()
      .mockResolvedValueOnce({ docs: [doc("notion:a", "kept")], full: true, cursor: "c1" })
      .mockRejectedValueOnce(new Error(`request failed with Bearer ${TOKEN}`));
    const h = harness({ notion: collector });
    await h.ingest.refresh(["notion"]);
    const [outcome] = await h.ingest.refresh(["notion"]);
    expect(outcome).toMatchObject({ kind: "notion", status: "failed" });
    expect(h.repo.list({ publicOnly: false }).map((c) => c.body)).toEqual(["kept"]);
    expect(h.repo.source("notion")?.cursor).toBe("c1");
    const status = JSON.stringify(h.ingest.status());
    expect(status).not.toContain(TOKEN);
    expect(status).toContain("[redacted]");
  });

  it("keeps other kinds running when Notion is not configured", async () => {
    const h = harness({
      notion: async () => ({ notConfigured: "notion token is not set" }),
      ludiars: async () => ({ docs: [doc("project:Ex", "Example", "public")], full: true, cursor: null }),
    });
    const out = await h.ingest.refresh();
    expect(out.map((o) => [o.kind, o.status])).toEqual([["ludiars", "refreshed"], ["notion", "not-configured"]]);
    expect(h.repo.list({ publicOnly: true }).map((c) => c.doc_key)).toEqual(["project:Ex"]);
    const notion = h.ingest.status().find((s) => s.kind === "notion")!;
    expect(notion.configured).toBe(false);
  });

  it("does not take in documents that hit the confidential dictionary", async () => {
    const h = harness({
      ludiars: async () => ({ docs: [doc("a", "mentions codename-x here"), doc("b", "plain")], full: true, cursor: null }),
    }, ["Codename-X"]);
    const [outcome] = await h.ingest.refresh(["ludiars"]);
    expect(outcome).toMatchObject({ status: "refreshed", docs: 1, excluded: 1 });
    expect(h.repo.list({ publicOnly: false }).map((c) => c.doc_key)).toEqual(["b"]);
  });

  it("reports counts per kind, type and scope", async () => {
    const h = harness({ ludiars: async () => ({ docs: [doc("a", "x", "public"), doc("b", "y", "hq")], full: true, cursor: null }) });
    await h.ingest.refresh(["ludiars"]);
    const ludiars = h.ingest.status().find((s) => s.kind === "ludiars")!;
    expect(ludiars.counts).toEqual([
      { doc_type: "notion-page", scope: "hq", docs: 1, chunks: 1 },
      { doc_type: "notion-page", scope: "public", docs: 1, chunks: 1 },
    ]);
    expect(ludiars.last_success_at).not.toBeNull();
  });
});

describe("redactReason (chat-knowledge-C-6)", () => {
  it("removes secrets and bearer values and keeps the reason short", () => {
    const out = redactReason(`x ${TOKEN} y Bearer abc ${"z".repeat(400)}`, [TOKEN, null]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("abc");
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
