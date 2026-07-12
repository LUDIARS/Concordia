import { describe, expect, it } from "vitest";
import { redisEnabled } from "./redis-cache.js";

describe("redisEnabled", () => {
  it("is explicit opt-in", () => {
    expect(redisEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(redisEnabled({ CONCORDIA_REDIS_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(redisEnabled({ CONCORDIA_REDIS_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(redisEnabled({ CONCORDIA_REDIS_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
