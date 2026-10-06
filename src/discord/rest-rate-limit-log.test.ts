import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RESTEvents } from "discord.js";
import { describeRateLimit, watchRestRateLimits } from "./rest-rate-limit-log.js";

describe("watchRestRateLimits", () => {
  it("logs the route, wait and whether the limit is global when discord.js waits on a 429", () => {
    const rest = new EventEmitter();
    const log = { warn: vi.fn() };
    watchRestRateLimits({ rest } as never, log);
    rest.emit(RESTEvents.RateLimited, {
      route: "/channels/:id/permissions/:id", method: "PUT", majorParameter: "123", timeToReset: 45_000, limit: 2, global: false,
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("route=/channels/:id/permissions/:id"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("wait_ms=45000"));
    expect(describeRateLimit({ route: "/x", method: "GET", majorParameter: "global", timeToReset: 1, limit: 1, global: true }))
      .toContain("global=true");
  });
});
