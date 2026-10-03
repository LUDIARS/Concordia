import { describe, expect, it } from "vitest";
import { compareMigrations } from "./compare.js";

const entry = (version: number, definition = "a") => ({ version, definition, name: definition });
describe("migration collision policy", () => {
  it("reports different definitions at the same newly introduced number", () => {
    expect(compareMigrations([entry(42)], [entry(42, "b")], [])).toEqual([
      { version: 42, leftName: "a", rightName: "b" },
    ]);
  });
  it("ignores inherited and independently identical definitions and distinct numbers", () => {
    expect(compareMigrations([entry(41), entry(42)], [entry(41), entry(42), entry(43)], [entry(41)])).toEqual([]);
  });
  it("detects reuse of an ancestor number with another definition", () => {
    expect(compareMigrations([entry(41)], [entry(41, "b")], [entry(41)])).toHaveLength(1);
  });
  it("returns stable numeric ordering without mutating snapshots", () => {
    const left = Object.freeze([entry(43), entry(42)]);
    expect(compareMigrations(left, [entry(42, "b"), entry(43, "b")], []).map(x => x.version)).toEqual([42, 43]);
    expect(left.map(x => x.version)).toEqual([43, 42]);
  });
});
