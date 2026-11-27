import type { Database } from "better-sqlite3";

export function initializeMemoriaPublication(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_flow_memoria_publications (
        article_id INTEGER PRIMARY KEY, publication_key TEXT NOT NULL UNIQUE,
        remote_id INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0)`);
}

// Memoria's local receiver must implement PUT by publication key. A lost
// acknowledgement can then be reconciled without creating a second article.
export async function publishApprovedArticle(db: Database, base: string, send = fetch): Promise<void> {
    const row = db.prepare(`SELECT p.article_id,p.publication_key,j.page,d.markdown
        FROM knowledge_flow_memoria_publications p
        JOIN knowledge_flow_jobs j ON j.article_id=p.article_id
        JOIN knowledge_flow_documents d ON d.article_id=p.article_id AND d.kind='knowledge'
        WHERE p.remote_id IS NULL AND p.next_attempt<=unixepoch()
        ORDER BY p.next_attempt,p.article_id LIMIT 1`).get() as
        { article_id: number; publication_key: string; page: string; markdown: string } | undefined;
    if (!row) return;
    const endpoint = new URL("/api/ai/articles/imports/" + encodeURIComponent(row.publication_key), base);
    if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
        throw new Error("Local Memoria URL required");
    const claim = db.prepare(`UPDATE knowledge_flow_memoria_publications SET next_attempt=unixepoch()+60
        WHERE article_id=? AND remote_id IS NULL AND next_attempt<=unixepoch()`).run(row.article_id);
    if (!claim.changes) return;
    const page = JSON.parse(row.page) as { title: string; url: string };
    const response = await send(endpoint, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: page.title, body_md: row.markdown, source_url: page.url }) });
    if (!response.ok) throw new Error("Memoria publication HTTP " + response.status);
    const result = await response.json() as { id?: number };
    if (!Number.isSafeInteger(result.id) || Number(result.id) < 1) throw new Error("Missing Memoria article ID");
    db.prepare("UPDATE knowledge_flow_memoria_publications SET remote_id=? WHERE article_id=?").run(result.id, row.article_id);
}
