import { describe, expect, it } from "vitest";
import { resolveErrorWatchSource, victoriaErrorWatchSource, victoriaLogsUrl } from "./error-watch-source.js";

describe("error watch source", () => {
  it("prefers the VictoriaLogs URL, then the log files root, else disables the watch", () => {
    expect(victoriaLogsUrl({ CONCORDIA_LOGS_VICTORIALOGS_URL: " http://127.0.0.1:9428 " })).toBe("http://127.0.0.1:9428");
    expect(victoriaLogsUrl({ VESTIGIUM_VICTORIALOGS_URL: "http://127.0.0.1:9428" })).toBe("http://127.0.0.1:9428");
    expect(victoriaLogsUrl({ CONCORDIA_LOGS_VICTORIALOGS_URL: "" })).toBeNull();
    expect(resolveErrorWatchSource({ VESTIGIUM_VICTORIALOGS_URL: "http://127.0.0.1:9428", CONCORDIA_ERROR_WATCH_LOGS_ROOT: "E:/logs" })?.label)
      .toBe("victorialogs http://127.0.0.1:9428");
    expect(resolveErrorWatchSource({ CONCORDIA_ERROR_WATCH_LOGS_ROOT: "E:/logs" })?.label).toBe("files root=E:/logs");
    expect(resolveErrorWatchSource({})).toBeNull();
  });

  it("reads only error and fatal rows newer than the watermark from VictoriaLogs", async () => {
    const urls: string[] = [];
    const source = victoriaErrorWatchSource("http://127.0.0.1:9428", async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => "" };
    });
    await source.recentErrors("revisor", Date.parse("2026-11-26T00:00:00Z"));
    const query = new URL(urls[0]!).searchParams.get("query") ?? "";
    expect(query).toContain('service:in("revisor")');
    expect(query).toContain("level:in(error,fatal)");
    expect(query).toContain("_time:>=2026-11-26T00:00:00.000Z");
  });
});
