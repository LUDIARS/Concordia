import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { initializeLedger } from "./article-ledger.js";
import { startThreadDelivery } from "./thread-delivery.js";
it("keeps an uncertain delivery for reconciliation and does not deliver it twice", async () => {
    const db = new Database(":memory:");
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error("timeout"); });
    initializeLedger(db);
    db.prepare("INSERT INTO knowledge_flow_notifications(id,channel,thread,text) VALUES ('id','channel','parent','report')").run();
    const stop = startThreadDelivery(db, send, () => { });
    try {
        await vi.advanceTimersByTimeAsync(5000);
        expect(send).toHaveBeenCalledTimes(1);
        expect(db.prepare("SELECT state FROM knowledge_flow_notifications").get()).toEqual({ state: "unknown" });
    }
    finally {
        await stop();
        vi.useRealTimers();
        db.close();
    }
});
