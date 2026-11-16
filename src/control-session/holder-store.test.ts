import { describe, expect, it } from "vitest";
import { CONTROL_HOLDER_KEY, ControlHolderStore, nextControlHolder, parseControlHolder } from "./holder-store.js";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
  };
}

describe("control holder", () => {
  it("starts at generation 1 and retires the previous spawn id on each hand-over", () => {
    const first = nextControlHolder(null, "spawn-a", 1000);
    expect(first).toEqual({ spawn_id: "spawn-a", generation: 1, spawned_at: 1000, retired: [] });
    const second = nextControlHolder(first, "spawn-b", 2000);
    expect(second.generation).toBe(2);
    expect(second.retired).toEqual([{ spawn_id: "spawn-a", notified: false }]);
  });

  it("keeps at most five retired generations", () => {
    let holder = nextControlHolder(null, "s0", 0);
    for (let i = 1; i <= 8; i += 1) holder = nextControlHolder(holder, `s${i}`, i);
    expect(holder.retired.map((r) => r.spawn_id)).toEqual(["s7", "s6", "s5", "s4", "s3"]);
  });

  it("treats broken stored values as no holder", () => {
    expect(parseControlHolder(null)).toBeNull();
    expect(parseControlHolder("not json")).toBeNull();
    expect(parseControlHolder(JSON.stringify({ spawn_id: "", generation: 1, spawned_at: 1 }))).toBeNull();
    expect(parseControlHolder(JSON.stringify({ spawn_id: "x", generation: 1.5, spawned_at: 1 }))).toBeNull();
  });

  it("persists, marks retired notices and clears through the settings store", () => {
    const store = memoryStore();
    const holders = new ControlHolderStore(store);
    holders.write(nextControlHolder(nextControlHolder(null, "old", 1), "new", 2));
    holders.markRetiredNotified("old");
    expect(holders.read()?.retired).toEqual([{ spawn_id: "old", notified: true }]);
    holders.clear();
    expect(store.values.has(CONTROL_HOLDER_KEY)).toBe(false);
    expect(holders.read()).toBeNull();
  });
});
