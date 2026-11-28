import type { Database } from "better-sqlite3";
import { assess, readArticleSource, type AnalysisSettings } from "./article-analysis.js";
import { isXSource } from "./x-source.js";
import { isNotionSource } from "./notion-article-source.js";
import { notifyArticle, renderReport, seedJobs, type Article } from "./article-ledger.js";
import { z } from "zod";
export interface WorkerSettings extends AnalysisSettings {
    session: string;
    ccUrl: string;
}
interface Job extends Article {
    request_id: string;
    task_ref: string | null;
    repo: string | null;
    attempts: number;
}
class TaskPaused extends Error {
}
async function cc(cfg: WorkerSettings, path: string, method = "GET", body?: unknown) {
    const url = new URL(path, cfg.ccUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        throw new Error("Local Cc URL required");
    const r = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
        .catch(() => { throw new TaskPaused("Cc connection unavailable"); });
    if (!r.ok)
        throw new TaskPaused("Cc HTTP " + r.status);
    return await r.json();
}
export async function advanceArticle(db: Database, cfg: WorkerSettings) {
    seedJobs(db);
    const sync = db.prepare("SELECT article_id,task_ref,repo,sync_status FROM knowledge_flow_jobs WHERE sync_status IS NOT NULL AND task_ref IS NOT NULL AND retry_after<=unixepoch() ORDER BY retry_after,article_id LIMIT 1").get() as {
        article_id: number;
        task_ref: string;
        repo: string;
        sync_status: string;
    } | undefined;
    if (sync) {
        db.prepare("UPDATE knowledge_flow_jobs SET retry_after=unixepoch()+30 WHERE article_id=?").run(sync.article_id);
        if (sync.sync_status === "blocked")
            await cc(cfg, "/v1/taskflow/tasks/article-block", "POST", { session_id: cfg.session, reference: sync.task_ref });
        else
            await cc(cfg, "/v1/taskflow/tasks/state", "PATCH", { repo_path: sync.repo, task_path: sync.task_ref, status: sync.sync_status });
        db.prepare("UPDATE knowledge_flow_jobs SET sync_status=NULL WHERE article_id=? AND sync_status=?").run(sync.article_id, sync.sync_status);
    }
    const job = db.prepare(`SELECT a.*,j.request_id,j.task_ref,j.repo,j.attempts FROM knowledge_flow_articles a
    JOIN knowledge_flow_jobs j ON a.id=j.article_id WHERE a.state IN ('open','analyzing','blocked') AND j.sync_status IS NULL AND j.retry_after<=unixepoch() ORDER BY j.retry_after,a.id LIMIT 1`).get() as Job | undefined;
    if (!job)
        return;
    const delay = db.prepare("UPDATE knowledge_flow_jobs SET retry_after=unixepoch()+30 WHERE article_id=?");
    delay.run(job.id);
    if (!job.task_ref) {
        const fromDiscord = db.prepare("SELECT 1 FROM knowledge_flow_receipts WHERE article_id=? AND duplicate=0 AND channel LIKE 'discord:%'").get(job.id);
        const source = fromDiscord ? "Discord" : "Slack";
        const created = z.object({ reference: z.string().startsWith("actio:"), repo_path: z.string() }).parse(await cc(cfg, "/v1/taskflow/tasks", "POST", {
            session_id: cfg.session, request_id: job.request_id, kind: "knowledge-article", title: "記事 #" + job.id, body: "指定"+source+"チャンネルの公開記事を審査する。対象 " + job.url
        }));
        db.prepare("UPDATE knowledge_flow_jobs SET task_ref=?,repo=? WHERE article_id=?").run(created.reference, created.repo_path, job.id);
        job.task_ref = created.reference;
        job.repo = created.repo_path;
    }
    const status = async () => z.object({ actio_status: z.string() }).parse(await cc(cfg, "/v1/taskflow/tasks/content?" + new URLSearchParams({ session_id: cfg.session, reference: job.task_ref! }))).actio_status;
    const permit = async () => { if (!["delegated", "in_progress"].includes(await status()))
        throw new TaskPaused("Cc task paused"); };
    if (job.state === "blocked") {
        if (await status() !== "open")
            return;
        db.transaction(() => {
            db.prepare("UPDATE knowledge_flow_articles SET state='open' WHERE id=?").run(job.id);
            db.prepare("UPDATE knowledge_flow_jobs SET attempts=0,error=NULL WHERE article_id=?").run(job.id);
        })();
        return;
    }
    if (job.state === "open") {
        const current = await status();
        if (!["open", "in_progress"].includes(current))
            return;
        if (current === "open")
            await cc(cfg, "/v1/taskflow/tasks/state", "PATCH", { repo_path: job.repo, task_path: job.task_ref, status: "delegated" });
        db.prepare("UPDATE knowledge_flow_articles SET state='analyzing' WHERE id=?").run(job.id);
    }
    let stage = isXSource(job.url) ? "Grok X本文取得（投稿URL・引用・公開範囲を確認）" : isNotionSource(job.url) ? "Notion本文取得（Claude の Notion コネクタの認証・ページの共有を確認）" : "Canalis 公開HTML取得（CC_KNOWLEDGE_CANALIS・URL・公開範囲を確認）";
    try {
        await permit();
        const article = await readArticleSource(job.url, cfg);
        const same = db.prepare("SELECT article_id FROM knowledge_flow_jobs WHERE body_hash=? AND article_id<>? ORDER BY article_id LIMIT 1").get(article.hash, job.id) as {
            article_id: number;
        } | undefined;
        if (same) {
            db.transaction(() => {
                db.prepare("UPDATE knowledge_flow_articles SET state='done' WHERE id=?").run(job.id);
                db.prepare("UPDATE knowledge_flow_jobs SET sync_status='done',page=? WHERE article_id=?").run(JSON.stringify(article), job.id);
                notifyArticle(db, job.id, "本文重複 · 元の記事 #" + same.article_id);
            })();
            return;
        }
        const related = db.prepare(`SELECT DISTINCT d.article_id,d.document FROM knowledge_flow_decisions d JOIN knowledge_flow_receipts r ON r.article_id=d.article_id
      JOIN knowledge_flow_receipts current ON current.team=r.team AND current.channel=r.channel AND current.duplicate=0
      WHERE current.article_id=? AND d.action IN ('adopt','skill') ORDER BY d.article_id DESC`).all(job.id) as {
            article_id: number;
            document: string;
        }[];
        const terms = [...new Set((article.title + " " + article.text.slice(0, 1000)).toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,5}|[\p{Script=Katakana}]{2,}/gu) ?? [])];
        const ranked = related.map(item => ({ item, score: terms.filter(term => item.document.toLowerCase().includes(term)).length }));
        const prior = ranked.filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(hit => hit.item);
        stage = "出典検索・本社評価（出典ホスト、モデル、応答形式を確認）";
        const report = await assess(article, prior, cfg, permit);
        await permit();
        db.transaction(() => {
            db.prepare("UPDATE knowledge_flow_jobs SET body_hash=?,page=?,report=?,error=NULL WHERE article_id=?").run(article.hash, JSON.stringify(article), JSON.stringify(report), job.id);
            db.prepare("UPDATE knowledge_flow_articles SET state='review' WHERE id=?").run(job.id);
            notifyArticle(db, job.id, renderReport(job.id, article.title, report) + "\n原記事 " + article.url + `\n過去の採用記事 ${related.length} 件中 ${prior.length} 件を比較`);
        })();
    }
    catch (error) {
        if (error instanceof TaskPaused)
            return;
        // External process errors can include command arguments or output. Keep diagnostic class only.
        const reason = stage + " · " + (error instanceof Error ? error.name : "Error");
        const blocked = job.attempts + 1 >= 4;
        db.transaction(() => {
            db.prepare("UPDATE knowledge_flow_jobs SET attempts=attempts+1,error=?,sync_status=? WHERE article_id=?").run(reason, blocked ? "blocked" : null, job.id);
            if (blocked) {
                db.prepare("UPDATE knowledge_flow_articles SET state='blocked' WHERE id=?").run(job.id);
                notifyArticle(db, job.id, `記事 #${job.id} ${job.url} · ${reason}。取得・分析の設定を確認し、ローカル画面から再分析してください。`);
            }
        })();
    }
}
