import { describe, expect, it } from "vitest";
import { nextControlHolder } from "./holder-store.js";
import { CONTROL_SPAWN_GRACE_MS, decideControlSingleton, spawnIdOf } from "./singleton-policy.js";

describe("decideControlSingleton", () => {
  const holder = nextControlHolder(null, "spawn-a", 1_000_000);

  it("spawns when no holder is recorded", () => {
    expect(decideControlSingleton({ holder: null, liveSessionId: null, nowMs: 0 })).toEqual({ action: "spawn", reason: "no_holder" });
  });

  it("keeps the live control session even across a Cc restart", () => {
    expect(decideControlSingleton({ holder, liveSessionId: "sess-1", nowMs: 99_999_999 })).toEqual({ action: "keep", sessionId: "sess-1" });
  });

  it("does not spawn again within the grace after the last spawn", () => {
    expect(decideControlSingleton({ holder, liveSessionId: null, nowMs: holder.spawned_at + CONTROL_SPAWN_GRACE_MS - 1 })).toEqual({ action: "wait" });
  });

  it("rebuilds once the grace has passed without a live session", () => {
    expect(decideControlSingleton({ holder, liveSessionId: null, nowMs: holder.spawned_at + CONTROL_SPAWN_GRACE_MS })).toEqual({ action: "spawn", reason: "not_live" });
  });
});

describe("spawnIdOf", () => {
  it("reads the Cc spawn correlation id from session metadata", () => {
    expect(spawnIdOf(JSON.stringify({ concordia_spawn_id: "abc" }))).toBe("abc");
    expect(spawnIdOf(JSON.stringify({ concordia_spawn_id: "" }))).toBeNull();
    expect(spawnIdOf(null)).toBeNull();
    expect(spawnIdOf("{broken")).toBeNull();
  });
});
