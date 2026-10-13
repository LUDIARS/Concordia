import { describe, expect, it } from "vitest";
import { createSiteActivityStore } from "./site-activity-store.js";
import type { SiteDayActivity } from "../daily/site-activity.js";

function memory() {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
}

const report = (date: string, count: number): SiteDayActivity => ({ date_iso: date, generated_at: 1, session_count: count, sessions: [] });

describe("site activity store", () => {
  it("同じ拠点・日付は後着で上書きし、 日付ごとに引ける", () => {
    const store = createSiteActivityStore(memory());
    store.record("mac", "Mac", report("2026-10-14", 1), 10);
    store.record("mac", "Mac", report("2026-10-14", 3), 20);
    store.record("aws", "AWS", report("2026-10-14", 2), 30);
    store.record("mac", "Mac", report("2026-10-13", 5), 40);

    const today = store.listForDate("2026-10-14");
    expect(today.map((e) => [e.site_id, e.report.session_count]).sort()).toEqual([["aws", 2], ["mac", 3]]);
    expect(store.listForDate("2026-10-13").map((e) => e.report.session_count)).toEqual([5]);
  });

  it("壊れた保存値は空として扱い、 次の記録で書き直す", () => {
    const settings = memory();
    settings.set("federation.hq.site_activity", "{not json");
    const store = createSiteActivityStore(settings);
    expect(store.listForDate("2026-10-14")).toEqual([]);
    store.record("mac", "Mac", report("2026-10-14", 1));
    expect(store.listForDate("2026-10-14")).toHaveLength(1);
  });
});
