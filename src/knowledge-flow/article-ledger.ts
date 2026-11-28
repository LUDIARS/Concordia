import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { initializeNotifications } from "./receipt-notification.js";
import { initializeThreadMaterials, queueThreadMaterials } from "./thread-materials.js";
import { initializeArticleDelegation } from "./article-delegation.js";
import type { assess } from "./article-analysis.js";
export type Report = Awaited<ReturnType<typeof assess>>;
export interface Article {
    id: number;
    url: string;
    state: string;
}
export function initializeLedger(db: Database) {
    initializeNotifications(db);
    initializeThreadMaterials(db);
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_flow_jobs (
    article_id INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, task_ref TEXT, repo TEXT, attempts INTEGER DEFAULT 0,
    body_hash TEXT, page TEXT, report TEXT, error TEXT, sync_status TEXT, retry_after INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS knowledge_flow_hash ON knowledge_flow_jobs(body_hash);
    CREATE TABLE IF NOT EXISTS knowledge_flow_decisions (
      id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL, action TEXT NOT NULL, document TEXT NOT NULL, actor TEXT NOT NULL,
      decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS knowledge_flow_documents (
      article_id INTEGER NOT NULL, kind TEXT NOT NULL, markdown TEXT NOT NULL, PRIMARY KEY(article_id,kind));
  `);
    initializeArticleDelegation(db);
}
export function seedJobs(db: Database) {
    db.transaction(() => {
        const rows = db.prepare("SELECT id FROM knowledge_flow_articles WHERE id NOT IN (SELECT article_id FROM knowledge_flow_jobs)").all() as {
            id: number;
        }[];
        const insert = db.prepare("INSERT INTO knowledge_flow_jobs(article_id,request_id) VALUES (?,?)");
        for (const row of rows)
            insert.run(row.id, randomUUID());
        const duplicates = db.prepare("SELECT rowid AS id,* FROM knowledge_flow_receipts WHERE duplicate=1 AND ('duplicate-'||rowid) NOT IN (SELECT id FROM knowledge_flow_notifications)").all() as {
            id: number;
            article_id: number;
            channel: string;
            thread_ts: string;
        }[];
        for (const item of duplicates)
            db.prepare("INSERT INTO knowledge_flow_notifications(id,channel,thread,text) VALUES (?,?,?,?)").run("duplicate-" + item.id, item.channel, item.thread_ts, "重複 · 記事 #" + item.article_id);
    }).immediate();
}
export function notifyArticle(db: Database, id: number, body: string) {
    const target = db.prepare("SELECT channel,thread_ts FROM knowledge_flow_receipts WHERE article_id=? AND duplicate=0 LIMIT 1").get(id) as {
        channel: string;
        thread_ts: string;
    };
    const chars = Array.from(body);
    const insert = db.prepare("INSERT INTO knowledge_flow_notifications(id,channel,thread,text) VALUES (?,?,?,?)");
    const chunkSize = target.channel.startsWith("discord:") ? 1000 : 3000;
    for (let n = 0; n < chars.length; n += chunkSize)
        insert.run(randomUUID(), target.channel, target.thread_ts, chars.slice(n, n + chunkSize).join(""));
}
export function renderReport(id: number, title: string, report: Report) {
    const e = report.evaluation;
    return [`# ${title}（記事 #${id}）`, e.verdict + " · " + e.category + " · " + e.tags.join(" / "), e.summary,
        "目的（推定） " + e.intent, "対象読者 " + e.audience, "難易度 " + e.difficulty, "再現条件 " + e.conditions,
        "既存知見 " + e.comparison, "反例 " + e.counterexamples, "判定理由 " + e.rationale,
        ...(e.breakEven == null ? [] : ["平均便益がゼロになる反例の割合 " + (e.breakEven * 100).toFixed(1) + "%"]),
        "効果 " + e.effect, ...e.measurements.map(m => `${m.condition} · ${m.control} → ${m.intervention} ${m.unit}（便益 ${m.benefit} ${m.unit}） ${m.url}`),
        ...e.claims.map(c => `${c.statement}\n原文「${c.articleQuote}」 出典「${c.sourceQuote}」 ${c.sourceUrl}`),
        ...(e.steps.length ? [e.verdict === "採用候補" ? "適用手順（採用前）" : "未採用・検証用", ...e.steps.map((s, i) => `${i + 1}. ${s.statement}\n原文「${s.articleQuote}」 出典「${s.sourceQuote}」 ${s.sourceUrl}`)] : []),
        ...report.unavailable.map(url => "取得不能 " + url)].join("\n");
}
export function decide(db: Database, id: number, action: string) {
    db.transaction(() => {
        const row = db.prepare(`SELECT a.state,j.report,j.page FROM knowledge_flow_articles a JOIN knowledge_flow_jobs j ON a.id=j.article_id WHERE a.id=?`).get(id) as {
            state: string;
            report: string | null;
            page: string | null;
        } | undefined;
        if (!row || !["review", "blocked"].includes(row.state))
            throw new Error("現在の状態では操作できません");
        if (action === "retry") {
            db.prepare("UPDATE knowledge_flow_jobs SET attempts=0,error=NULL,retry_after=0,sync_status='pending' WHERE article_id=?").run(id);
            db.prepare("UPDATE knowledge_flow_articles SET state='open' WHERE id=?").run(id);
            return;
        }
        if (row.state !== "review" || !row.report || !row.page || !["adopt", "skill", "skip"].includes(action))
            throw new Error("操作できません");
        const report = JSON.parse(row.report) as Report;
        if (action !== "skip" && (report.evaluation.verdict !== "採用候補" || (action === "skill" && !report.evaluation.technical)))
            throw new Error("採用条件を満たしていません");
        const page = JSON.parse(row.page) as {
            title: string;
            url: string;
        };
        const document = renderReport(id, page.title, report) + "\n原記事 " + page.url;
        if (action !== "skip") {
            const put = db.prepare("INSERT INTO knowledge_flow_documents(article_id,kind,markdown) VALUES (?,?,?)");
            put.run(id, "knowledge", document);
            if (report.evaluation.technical) {
                const procedure = ["# " + page.title, report.evaluation.conditions, ...report.evaluation.steps.map((s, i) => (i + 1) + ". " + s.statement + "\n   出典 " + s.sourceUrl), "原記事 " + page.url].join("\n\n");
                put.run(id, "procedure", procedure);
                if (action === "skill")
                    put.run(id, "skill", "---\nname: article-" + id + "\ndescription: " + JSON.stringify(report.evaluation.summary) + "\n---\n\n" + procedure);
            }
        }
        if (action !== "skip") queueThreadMaterials(db,id,page.title,page.url,report.evaluation,action==="skill");
        db.prepare("INSERT INTO knowledge_flow_decisions(article_id,action,document,actor) VALUES (?,?,?,'本社PCのローカル利用者')").run(id, action, document);
        db.prepare("UPDATE knowledge_flow_jobs SET sync_status='done' WHERE article_id=?").run(id);
        db.prepare("UPDATE knowledge_flow_articles SET state='done' WHERE id=?").run(id);
        notifyArticle(db, id, `記事 #${id} · ${action === "skip" ? "見送り" : action === "skill" ? "ナレッジ・手順書・AIスキル採用" : "採用"}`);
    }).immediate();
}
