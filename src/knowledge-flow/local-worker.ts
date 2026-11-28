import Database from "better-sqlite3";
import { initializeLedger } from "./article-ledger.js";
import { advanceArticle, type WorkerSettings } from "./article-worker.js";
import { reviewServer } from "./review-server.js";
import { memoriaBaseUrl } from "../config/service-urls.js";
import { publishApprovedArticle } from "./memoria-publication.js";
import { setTimeout as wait } from "node:timers/promises";
import { runClaude } from "../rules/claude-runner.js";
function required(name: string): string { const v = process.env[name]?.trim(); if (!v)
    throw new Error("Missing " + name); return v; }
const cfg: WorkerSettings = { session: required("CC_KNOWLEDGE_SESSION"), ccUrl: required("CC_KNOWLEDGE_CC_URL"), canalis: required("CC_KNOWLEDGE_CANALIS"),
    hosts: required("CC_KNOWLEDGE_SOURCE_HOSTS").split(",").map(s => s.trim().toLowerCase()).filter(Boolean), xaiKey: required("XAI_API_KEY"), grok: required("CC_KNOWLEDGE_GROK_MODEL"),
    hqUrl: required("CC_KNOWLEDGE_HQ_CHAT_URL"), hqModel: required("CC_KNOWLEDGE_HQ_MODEL"),
    notion: (prompt, opts) => runClaude(prompt, opts) };
const db = new Database(required("CC_KNOWLEDGE_DB"), { fileMustExist: true });
db.pragma("busy_timeout=5000");
const server = reviewServer(db);
let stopped = false;
process.once("SIGINT", () => { stopped = true; });
process.once("SIGTERM", () => { stopped = true; });
try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_flow_articles'").get())
        throw new Error("Configure Slack reception first");
    initializeLedger(db);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8787, "127.0.0.1", resolve); });
    while (!stopped) {
        try {
            await advanceArticle(db, cfg);
        }
        catch (e) {
            process.stderr.write("Knowledge flow worker: " + (e instanceof Error ? e.name : "error") + "\n");
        }
        if (!stopped)
            await publishApprovedArticle(db, memoriaBaseUrl()).catch(error => {
                process.stderr.write("Memoria publication: " + (error instanceof Error ? error.message : "failed") + "\n");
            });
        if (!stopped)
            await wait(2000);
    }
}
finally {
    if (server.listening)
        await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
}
