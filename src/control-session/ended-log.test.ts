import { describe, expect, it } from "vitest";
import { CONTROL_ENDED_LOG_KEY, CONTROL_ENDED_LOG_LIMIT, createEndedLog, parseEndedLog } from "./ended-log.js";

function store() {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
  };
}

describe("ended session log", () => {
  it("appends, lists and clears ended sessions under an internal key", () => {
    const settings = store();
    const log = createEndedLog(settings);
    log.append([]);
    expect(settings.values.has(CONTROL_ENDED_LOG_KEY)).toBe(false);
    log.append([{ session_id: "a", project: "Cc", reason: "担当 PR がマージ済み", ended_at: 1 }]);
    log.append([{ session_id: "b", project: "At", reason: "委託 run の終了を親が受け取り済み", ended_at: 2 }]);
    expect(log.list().map((r) => r.session_id)).toEqual(["a", "b"]);
    log.clear();
    expect(log.list()).toEqual([]);
    expect(CONTROL_ENDED_LOG_KEY.startsWith("admin.") || CONTROL_ENDED_LOG_KEY.startsWith("harness.")).toBe(false);
  });

  it("keeps only the newest records up to the limit and ignores broken values", () => {
    const settings = store();
    const log = createEndedLog(settings);
    log.append(Array.from({ length: CONTROL_ENDED_LOG_LIMIT + 5 }, (_, i) => ({ session_id: `s${i}`, project: "Cc", reason: "r", ended_at: i })));
    expect(log.list()).toHaveLength(CONTROL_ENDED_LOG_LIMIT);
    expect(log.list()[0].session_id).toBe("s5");
    expect(parseEndedLog("{")).toEqual([]);
    expect(parseEndedLog(JSON.stringify([{ session_id: 1 }]))).toEqual([]);
  });
});
