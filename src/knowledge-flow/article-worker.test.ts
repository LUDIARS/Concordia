import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createArticleInbox } from "./slack-receipt.js";
import { initializeLedger } from "./article-ledger.js";
import { advanceArticle, type WorkerSettings } from "./article-worker.js";
import { readArticleSource } from "./article-analysis.js";
afterEach(() => vi.unstubAllGlobals());
it("uses X Search for a post and accepts only the requested post's citation and available original", async () => {
    const cfg = { hosts: [], grok: "configured-model", xaiKey: "test", canalis: "unused", hqModel: "", hqUrl: "" };
    const url = "https://x.com/author/status/123?s=20";
    const answer = (citation: string, original: string | null) => Response.json({ output: [{ type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ original }), annotations: [{ url: citation }] }] }] });
    const http = vi.fn().mockResolvedValueOnce(answer("https://twitter.com/i/web/status/123", "本文"))
        .mockResolvedValueOnce(answer("https://x.com/author/status/456", "別記事"))
        .mockResolvedValueOnce(answer(url, null));
    vi.stubGlobal("fetch", http);
    expect(await readArticleSource(url, cfg)).toMatchObject({ url, text: "本文" });
    expect(JSON.parse(http.mock.calls[0][1].body).tools).toEqual([{ type: "x_search" }]);
    await expect(readArticleSource(url, cfg)).rejects.toThrow("did not cite");
    await expect(readArticleSource(url, cfg)).rejects.toThrow("Empty X source");
    await expect(readArticleSource("https://x.com.example.org/article", cfg)).rejects.toThrow("Canalis executable");
    expect(http).toHaveBeenCalledTimes(3);
});
it("retains the same request identity when Cc is unavailable, and pauses a manually blocked task", async () => {
    const db = new Database(":memory:");
    const cfg: WorkerSettings = { ccUrl: "http://localhost", session: "session", canalis: "unused", hosts: [], grok: "unused", xaiKey: "unused", hqModel: "unused", hqUrl: "http://localhost", articleDir: "unused" };
    try {
        const save = createArticleInbox(db, ["T/C"]);
        initializeLedger(db);
        save("T", "e", { user: "U", ts: "1", channel: "C", text: "https://example.org" }, null);
        const http = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(Response.json({ reference: "actio:x", repo_path: "repo" })).mockResolvedValueOnce(Response.json({ actio_status: "blocked" }));
        vi.stubGlobal("fetch", http);
        await expect(advanceArticle(db, cfg)).rejects.toThrow();
        db.prepare("UPDATE knowledge_flow_jobs SET retry_after=0").run();
        await advanceArticle(db, cfg);
        expect(JSON.parse(http.mock.calls[0][1].body).request_id).toBe(JSON.parse(http.mock.calls[1][1].body).request_id);
        expect(db.prepare("SELECT state FROM knowledge_flow_articles").get()).toEqual({ state: "open" });
        expect(http).toHaveBeenCalledTimes(3);
    }
    finally {
        db.close();
    }
});
