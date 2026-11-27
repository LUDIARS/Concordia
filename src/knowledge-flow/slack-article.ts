interface Message {
    ts?: string;
    thread_ts?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
}
export interface ArticleEvent extends Message {
    channel?: string;
    message?: Message;
    previous_message?: Message;
}
function links(text = ""): Set<string> {
    const found = new Set<string>();
    for (const match of text.matchAll(/<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]+)/gi)) {
        try {
            const url = new URL((match[1] ?? match[2]).replace(/&amp;/g, "&"));
            if (url.username || url.password)
                continue;
            url.hash = "";
            found.add(url.href);
        }
        catch { /* Ignore malformed links individually. */ }
    }
    return found;
}
export function articleSubmission(event: ArticleEvent, botUser: string | null) {
    const edited = event.subtype === "message_changed";
    if (event.subtype && !edited && event.subtype !== "thread_broadcast")
        return null;
    const message = edited ? event.message : event;
    if (!message?.ts || message.bot_id || !message.user || message.user === botUser)
        return null;
    const previous = edited ? links(event.previous_message?.text) : new Set<string>();
    return {
        ts: message.ts, thread: message.thread_ts ?? message.ts,
        urls: [...links(message.text)].filter(url => !previous.has(url)),
    };
}
