import type { Database } from "better-sqlite3";
import { articleSubmission, type ArticleEvent } from "./slack-article.js";
import { acknowledgeReceipt, initializeNotifications } from "./receipt-notification.js";
// A receipt owns the message-to-article association, independently of worker availability.
export function createArticleInbox(db: Database, scopes: readonly string[], watches?: (team: string, channel: string) => boolean) {
    const allowed = new Set(scopes);
    if (allowed.size || watches) {
        initializeNotifications(db);
        db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_flow_articles (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'open',
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS knowledge_flow_receipts (
      team TEXT NOT NULL, channel TEXT NOT NULL, event_id TEXT NOT NULL, message_ts TEXT NOT NULL,
      thread_ts TEXT NOT NULL, article_id INTEGER NOT NULL REFERENCES knowledge_flow_articles(id),
      duplicate INTEGER NOT NULL, PRIMARY KEY(team, channel, event_id, article_id)
    );`);
    }
    const save = db.transaction((team: string, channel: string, id: string, event: ArticleEvent, bot: string | null) => {
        const submission = articleSubmission(event, bot);
        if (!submission)
            return;
        for (const url of submission.urls) {
            const result = db.prepare("INSERT INTO knowledge_flow_articles(url) VALUES (?) ON CONFLICT(url) DO NOTHING").run(url);
            const article = db.prepare("SELECT id FROM knowledge_flow_articles WHERE url=?").get(url) as {
                id: number;
            };
            // A Discord partial update may not include the previous text.
            if (event.subtype === "message_changed" && db.prepare("SELECT 1 FROM knowledge_flow_receipts WHERE team=? AND channel=? AND message_ts=? AND article_id=?").get(team,channel,submission.ts,article.id)) continue;
            const receipt = db.prepare(`INSERT INTO knowledge_flow_receipts(team,channel,event_id,message_ts,thread_ts,article_id,duplicate)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(team, channel, id, submission.ts, submission.thread, article.id, Number(!result.changes));
            if (receipt.changes) acknowledgeReceipt(db, receipt.lastInsertRowid, article.id, channel, submission.thread, !result.changes);
        }
    });
    return (team: string | undefined, eventId: string | undefined, event: ArticleEvent, bot: string | null): void => {
        if (!team || !event.channel || !(allowed.has(team + "/" + event.channel) || watches?.(team,event.channel)))
            return;
        if (!eventId)
            throw new Error("Missing Slack event identity");
        save.immediate(team, event.channel, eventId, event, bot);
    };
}
