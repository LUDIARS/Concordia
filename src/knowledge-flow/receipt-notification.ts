import type { Database } from "better-sqlite3";

export function initializeNotifications(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_flow_notifications (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      retry_after INTEGER NOT NULL DEFAULT 0)`);
}

export function acknowledgeReceipt(db: Database, receipt: number | bigint, article: number, channel: string, thread: string, duplicate: boolean): void {
    const id = (duplicate ? "duplicate-" : "receipt-") + receipt;
    const text = duplicate ? "重複 · 記事 #" + article : "記事 #" + article + " を受け付けました。ナレッジとして取り込みます。";
    db.prepare("INSERT INTO knowledge_flow_notifications(id,channel,thread,text) VALUES (?,?,?,?)").run(id, channel, thread, text);
}
