import type { Database } from "better-sqlite3";
import type { Evaluation } from "./article-analysis.js";
import { initializeMemoriaPublication } from "./memoria-publication.js";
import { randomUUID } from "node:crypto";

export interface ThreadMaterial { name: string; markdown: string }
export function initializeThreadMaterials(db: Database): void {
  initializeMemoriaPublication(db);
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_flow_publication_channel (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), guild TEXT NOT NULL, channel TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_flow_thread_materials (
    notice TEXT NOT NULL, name TEXT NOT NULL, markdown TEXT NOT NULL, PRIMARY KEY(notice,name));`);
}

export function configurePublicationChannel(db: Database, guild: string, channel: string): void {
  initializeThreadMaterials(db);
  db.prepare(`INSERT INTO knowledge_flow_publication_channel(singleton,guild,channel) VALUES (1,?,?)
    ON CONFLICT(singleton) DO UPDATE SET guild=excluded.guild,channel=excluded.channel`).run(guild, channel);
}

// The approval and these immutable delivery snapshots are committed together.
export function queueThreadMaterials(db: Database, articleId: number, title: string, url: string, evaluation: Evaluation, skillApproved: boolean): void {
  const target = db.prepare(`SELECT r.channel,r.thread_ts FROM knowledge_flow_receipts r
    JOIN knowledge_flow_publication_channel p ON r.channel='discord:'||p.guild||':'||p.channel
    WHERE r.article_id=? ORDER BY r.duplicate,r.rowid LIMIT 1`).get(articleId) as {channel:string;thread_ts:string}|undefined;
  if (!target) return;
  db.prepare("INSERT INTO knowledge_flow_memoria_publications(article_id,publication_key) VALUES (?,?)").run(articleId,randomUUID());
  const notice = "approved-materials-" + articleId;
  const memory = ["# "+title, evaluation.summary, "## 適用条件", evaluation.conditions,
    "## 反例", evaluation.counterexamples, "## 根拠", ...evaluation.claims.map(c=>"- "+c.statement+" — "+c.sourceUrl), "原記事 "+url].join("\n\n");
  const insert = db.prepare("INSERT INTO knowledge_flow_thread_materials(notice,name,markdown) VALUES (?,?,?)");
  insert.run(notice,"MEMORY.md",memory);
  if (skillApproved) {
    const skill = db.prepare("SELECT markdown FROM knowledge_flow_documents WHERE article_id=? AND kind='skill'").get(articleId) as {markdown:string}|undefined;
    if (!skill) throw new Error("Approved skill document missing");
    insert.run(notice,"SKILL.md",skill.markdown);
  }
  db.prepare("INSERT INTO knowledge_flow_notifications(id,channel,thread,text) VALUES (?,?,?,?)")
    .run(notice,target.channel,target.thread_ts,"記事 #"+articleId+" の採用資料 · "+title);
}
export function threadMaterials(db: Database, notice: string): ThreadMaterial[] {
  return db.prepare("SELECT name,markdown FROM knowledge_flow_thread_materials WHERE notice=? ORDER BY name").all(notice) as ThreadMaterial[];
}
