/**
 * ナレッジフローの記事本文の取得を Cc の委託で行う (spec/feature/slack-knowledge-flow.md KF-7)。
 *
 * 取得経路はナレッジフローが決める (articleRoute)。 X は Grok、 Notion は Claude の Notion コネクタの委託を
 * Cc に起動させ、 委託先が保存したファイルを読む。 ふつうの Web ページは委託せず Canalis で読む。
 * - 起動と委託の状態の管理は Cc (POST /v1/delegations/invoke、 GET /v1/delegations/runs/:id/status)
 * - 待つ間はワーカーの巡回を止めない (起動して戻り、 次の巡回で保存先を見る)
 * - 委託の run は記事の Actio task に結びつけない (run の終了で記事の task が閉じないように)
 */

import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CLAUDE_NOTION_KNOWLEDGE_ARTICLE, GROK_KNOWLEDGE_ARTICLE } from "../delegation/knowledge-article-templates.js";
import { isNotionSource } from "./notion-article-source.js";
import { isXSource } from "./x-source.js";

export type ArticleRoute = "grok" | "notion" | "canalis";

/** 記事本文の取得経路。 ナレッジフローが決める。 */
export function articleRoute(url: string): ArticleRoute {
    if (isXSource(url)) return "grok";
    if (isNotionSource(url)) return "notion";
    return "canalis";
}

const CALL_NAME = { grok: GROK_KNOWLEDGE_ARTICLE, notion: CLAUDE_NOTION_KNOWLEDGE_ARTICLE } as const;

/** 委託の結果を待つ上限 (秒)。 超えたら取得失敗として数える。 */
export const ARTICLE_DELEGATION_TIMEOUT_S = 900;
/** 結果の確認の間隔 (秒)。 */
const CHECK_INTERVAL_S = 15;

export function initializeArticleDelegation(db: Database): void {
    const columns = new Set((db.prepare("PRAGMA table_info(knowledge_flow_jobs)").all() as { name: string }[]).map(c => c.name));
    for (const [name, type] of [["fetch_run", "TEXT"], ["fetch_path", "TEXT"], ["fetch_deadline", "INTEGER"]] as const)
        if (!columns.has(name)) db.exec(`ALTER TABLE knowledge_flow_jobs ADD COLUMN ${name} ${type}`);
}

/** 委託先が保存した Markdown (# 題 / ## 原文 / ## 要約) から原文を取り出す。 形が違えば null。 */
export function parseSavedArticle(markdown: string, url: string) {
    const text = markdown.replace(/\r\n/g, "\n");
    const title = /^#[ \t]+(.+)$/m.exec(text)?.[1]?.trim();
    const original = /^##[ \t]*原文[ \t]*\n([\s\S]*?)(?=^##[ \t]*要約|(?![\s\S]))/m.exec(text)?.[1]?.trim();
    if (!original) return null;
    return { url, title: (title ?? original.split("\n")[0]).slice(0, 200), text: original, fetchedAt: new Date().toISOString(),
        hash: createHash("sha256").update(original).digest("hex") };
}
export type DelegatedPage = NonNullable<ReturnType<typeof parseSavedArticle>>;

export type CcRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;

export interface ArticleDelegationSettings {
    session: string;
    /** 委託先に保存させるディレクトリ (絶対パス)。 */
    articleDir: string;
}

/**
 * 委託で記事本文を取る。 まだ結果が無ければ null (次の巡回で見る)。 委託が結果なしで終わった・時間切れは例外。
 */
export async function delegatedArticle(db: Database, cfg: ArticleDelegationSettings, cc: CcRequest,
    job: { id: number; url: string }, route: Exclude<ArticleRoute, "canalis">): Promise<DelegatedPage | null> {
    const row = db.prepare("SELECT fetch_run,fetch_path,fetch_deadline FROM knowledge_flow_jobs WHERE article_id=?").get(job.id) as {
        fetch_run: string | null; fetch_path: string | null; fetch_deadline: number | null } | undefined;
    const wait = db.prepare("UPDATE knowledge_flow_jobs SET retry_after=unixepoch()+? WHERE article_id=?");
    if (!row?.fetch_run || !row.fetch_path) {
        if (!isAbsolute(cfg.articleDir)) throw new Error("Article directory must be an absolute path");
        await mkdir(cfg.articleDir, { recursive: true });
        const path = join(cfg.articleDir, `article-${job.id}-${Date.now()}.md`);
        const started = z.object({ ok: z.literal(true), run: z.object({ id: z.string().min(1) }) }).parse(await cc("/v1/delegations/invoke", "POST", {
            call_name: CALL_NAME[route], args: { url: job.url, save_path: path }, spawn: true,
            parent_session_id: cfg.session, triggered_by: "knowledge-flow",
        }));
        db.prepare("UPDATE knowledge_flow_jobs SET fetch_run=?,fetch_path=?,fetch_deadline=unixepoch()+? WHERE article_id=?")
            .run(started.run.id, path, ARTICLE_DELEGATION_TIMEOUT_S, job.id);
        wait.run(CHECK_INTERVAL_S, job.id);
        return null;
    }
    const clear = () => db.prepare("UPDATE knowledge_flow_jobs SET fetch_run=NULL,fetch_path=NULL,fetch_deadline=NULL WHERE article_id=?").run(job.id);
    const saved = await readFile(row.fetch_path, "utf8").catch(() => null);
    const page = saved === null ? null : parseSavedArticle(saved, job.url);
    if (page) {
        clear();
        return page;
    }
    const status = z.object({ terminal: z.boolean() }).parse(await cc(`/v1/delegations/runs/${encodeURIComponent(row.fetch_run)}/status`));
    const expired = (row.fetch_deadline ?? 0) <= Math.floor(Date.now() / 1000);
    if (status.terminal || expired) {
        clear();
        throw new Error(status.terminal ? "Article delegation ended without a saved article" : "Article delegation timed out");
    }
    wait.run(CHECK_INTERVAL_S, job.id);
    return null;
}
