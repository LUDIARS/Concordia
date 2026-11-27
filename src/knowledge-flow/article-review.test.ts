import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { verifyEvaluation, type Page } from "./article-analysis.js";
import { createArticleInbox } from "./slack-receipt.js";
import { decide, initializeLedger, seedJobs } from "./article-ledger.js";
import { configurePublicationChannel, threadMaterials } from "./thread-materials.js";
import { publishApprovedArticle } from "./memoria-publication.js";
const article: Page = { url: "https://example.org/article", title: "記事", text: "処理時間を減らす", hash: "a" };
const source: Page = { ...article, url: "https://source.org/result", text: "通常 20→15 ms。競合 30→40 ms。", hash: "b" };
const assertion = { statement: "処理時間を比較", articleQuote: "処理時間", sourceUrl: source.url, sourceQuote: "通常 20→15 ms" };
const evaluation = { summary: "比較", intent: "解説", audience: "開発者", difficulty: "中", conditions: "通常時", category: "開発", tags: [], verdict: "採用候補", rationale: "数値を照合", comparison: "なし", counterexamples: "競合時", effect: "試算", claims: [assertion], steps: [assertion], technical: true,
    measurements: [["通常", 20, 15], ["反例", 30, 40]].map(([scenario, control, intervention]) => ({ scenario, control, intervention, unit: "ms", quote: source.text, url: source.url, lowerBetter: true, condition: scenario, metric: "処理時間", basis: "1回" })) };
it("compares verified quantities from the same experiment and flags missing independent evidence", () => {
    expect(verifyEvaluation(evaluation, article, [source]).breakEven).toBeCloseTo(1 / 3);
    expect(verifyEvaluation(evaluation, article, [{ ...source, hash: "a" }]).verdict).toBe("保留");
});
it("stores the chosen document types with the reviewer and reserves the reply in the same transaction", async () => {
    const db = new Database(":memory:");
    try {
        const save = createArticleInbox(db, ["T/C"]);
        initializeLedger(db);
        save("T", "e", { channel: "C", user: "U", ts: "1", text: article.url }, null);
        seedJobs(db);
        const report = { evaluation: verifyEvaluation(evaluation, article, [source]), evidence: [source], unavailable: [] };
        db.prepare("UPDATE knowledge_flow_articles SET state='review'").run();
        db.prepare("UPDATE knowledge_flow_jobs SET report=?,page=?").run(JSON.stringify(report), JSON.stringify(article));
        configurePublicationChannel(db, "123", "456");
        db.prepare("UPDATE knowledge_flow_receipts SET channel=?,thread_ts=?").run("discord:123:456", "post:456:789");
        decide(db, 1, "skill");
        const materials = threadMaterials(db, "approved-materials-1");
        expect(materials.map(material => material.name)).toEqual(["MEMORY.md", "SKILL.md"]);
        expect(materials[0].markdown).toContain(source.url);
        let writes = 0;
        const receive: typeof fetch = async (url, request) => {
            expect(String(url)).toMatch(/^http:\/\/localhost\/api\/ai\/articles\/imports\//);
            expect(request?.method).toBe("PUT");
            expect(JSON.parse(String(request?.body)).body_md).toContain(article.url);
            writes++;
            return Response.json({ id: 42 });
        };
        await publishApprovedArticle(db, "http://localhost", receive);
        await publishApprovedArticle(db, "http://localhost", receive);
        expect(writes).toBe(1);
        expect(db.prepare("SELECT remote_id FROM knowledge_flow_memoria_publications").get()).toEqual({ remote_id: 42 });
        expect(db.prepare("SELECT thread FROM knowledge_flow_notifications WHERE id='approved-materials-1'").get()).toEqual({ thread: "post:456:789" });
        expect(db.prepare("SELECT kind FROM knowledge_flow_documents ORDER BY kind").all()).toEqual(["knowledge", "procedure", "skill"].map(kind => ({ kind })));
        expect(db.prepare("SELECT state FROM knowledge_flow_notifications").get()).toEqual({ state: "pending" });
        expect(() => decide(db, 1, "skill")).toThrow();
    }
    finally {
        db.close();
    }
});
