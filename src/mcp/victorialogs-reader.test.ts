import { describe, expect, it } from "vitest";
import { createVictoriaLogsReader, isServiceCode, serviceLogQuery, toVestigiumRecord, type FetchLike } from "./victorialogs-reader.js";

function fakeFetch(body: string, status = 200) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetchImpl, urls };
}

const row = (time: string, msg: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ _time: time, _msg: msg, service: "concordia", kind: "service", level: "error", channel: "stderr", pid: "63304", ...extra });

describe("toVestigiumRecord", () => {
  it("maps a VictoriaLogs row to the file reader's record", () => {
    expect(toVestigiumRecord({ _time: "2026-11-26T11:45:01.609Z", _msg: "boom", service: "concordia", level: "error", channel: "stderr", pid: "63304", "ctx.contract": "rv-list-C-4" }))
      .toEqual({ ts: Date.parse("2026-11-26T11:45:01.609Z"), level: "error", service: "concordia", channel: "stderr", msg: "boom", pid: 63304, ctx: { contract: "rv-list-C-4" } });
  });

  it("rejects rows without a time, service or message and defaults unknown level and channel", () => {
    expect(toVestigiumRecord({ _msg: "x", service: "a" })).toBeNull();
    expect(toVestigiumRecord({ _time: "2026-11-26T00:00:00Z", _msg: "x" })).toBeNull();
    expect(toVestigiumRecord({ _time: "2026-11-26T00:00:00Z", _msg: "x", service: "a", level: "loud", channel: "pipe" }))
      .toMatchObject({ level: "info", channel: "app", ctx: undefined, pid: undefined });
  });
});

describe("serviceLogQuery", () => {
  it("embeds only validated service codes, levels and an ISO lower bound", () => {
    expect(serviceLogQuery({ services: ["concordia", "bad code\")"], levels: ["error", "fatal"], sinceMs: Date.parse("2026-11-26T00:00:00Z") }))
      .toBe('kind:service AND service:in("concordia") AND level:in(error,fatal) AND _time:>=2026-11-26T00:00:00.000Z');
    expect(() => serviceLogQuery({ services: ["../etc"] })).toThrow();
    expect(isServiceCode("revisor")).toBe(true);
    expect(isServiceCode("Revisor")).toBe(false);
  });
});

describe("createVictoriaLogsReader", () => {
  it("queries newest first with a bounded limit and skips broken lines", async () => {
    const { fetchImpl, urls } = fakeFetch([row("2026-11-26T11:45:02Z", "second"), "not json", row("2026-11-26T11:45:01Z", "first")].join("\n"));
    const reader = createVictoriaLogsReader({ origin: "http://127.0.0.1:9428", fetch: fetchImpl });
    const records = await reader.recent({ service: "concordia", limit: 99_999, level: ["error"] });
    expect(records.map((r) => r.msg)).toEqual(["second", "first"]);
    const query = new URL(urls[0]!).searchParams.get("query");
    expect(query).toContain("sort by (_time desc) | limit 5000");
    expect(new URL(urls[0]!).pathname).toBe("/select/logsql/query");
  });

  it("applies the search pattern as an ECMAScript regex on the message", async () => {
    const { fetchImpl } = fakeFetch([row("2026-11-26T11:45:02Z", "Taskflow request failed"), row("2026-11-26T11:45:01Z", "ok")].join("\n"));
    const reader = createVictoriaLogsReader({ origin: "http://127.0.0.1:9428", fetch: fetchImpl });
    expect((await reader.search({ services: ["concordia"], pattern: "taskflow" })).map((r) => r.msg)).toEqual(["Taskflow request failed"]);
  });

  it("lists valid service codes from field values and reports HTTP failures", async () => {
    const listing = fakeFetch(JSON.stringify({ values: [{ value: "revisor" }, { value: "actio" }, { value: "Bad Code" }] }));
    expect(await createVictoriaLogsReader({ origin: "http://127.0.0.1:9428", fetch: listing.fetchImpl }).listServices()).toEqual(["actio", "revisor"]);
    const failing = fakeFetch("", 503);
    await expect(createVictoriaLogsReader({ origin: "http://127.0.0.1:9428", fetch: failing.fetchImpl }).lastSeenAt("actio")).rejects.toThrow("HTTP 503");
  });

  it("refuses an origin that carries credentials", () => {
    expect(() => createVictoriaLogsReader({ origin: "http://user:pass@127.0.0.1:9428" })).toThrow();
  });
});
