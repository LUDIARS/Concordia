import type { Database } from "better-sqlite3";
export function startThreadDelivery(db: Database, send: (channel: string, thread: string, text: string, id: string) => Promise<void>, warn: (message: string) => void, discordGuild?: string) {
    let active: Promise<void> | undefined;
    async function deliver() {
        const route = discordGuild ? "channel LIKE ?" : "channel NOT LIKE ?";
        const prefix = discordGuild ? "discord:" + discordGuild + ":%" : "discord:%";
        const row = db.prepare("SELECT * FROM knowledge_flow_notifications WHERE state='pending' AND retry_after<=unixepoch() AND "+route+" ORDER BY rowid LIMIT 1").get(prefix) as {
            id: string;
            channel: string;
            thread: string;
            text: string;
        } | undefined;
        if (!row)
            return;
        if (!db.prepare("UPDATE knowledge_flow_notifications SET state='sending' WHERE id=? AND state='pending'").run(row.id).changes)
            return;
        try {
            await send(row.channel, row.thread, row.text, row.id);
        }
        catch (error) {
            const code = (error as {
                data?: {
                    error?: string;
                };
            }).data?.error;
            const discordError = discordGuild ? (error as {status?:number}).status : undefined;
            const state = discordError === 429 ? "pending"
                : discordError && discordError >= 400 && discordError < 500 ? "failed"
                : code && ["channel_not_found", "not_in_channel", "missing_scope", "is_archived"].includes(code) ? "failed" : code ? "pending" : "unknown";
            db.prepare("UPDATE knowledge_flow_notifications SET state=?,retry_after=unixepoch()+60 WHERE id=?").run(state, row.id);
            return;
        }
        db.prepare("UPDATE knowledge_flow_notifications SET state='sent' WHERE id=?").run(row.id);
    }
    const timer = setInterval(() => {
        if (!active)
            active = deliver().catch(e => warn(String(e))).finally(() => { active = undefined; });
    }, 2000);
    timer.unref();
    return async () => { clearInterval(timer); await active; };
}
