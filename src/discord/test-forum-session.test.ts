import { describe, expect, it } from "vitest";
import { readTestSurfaceId } from "./test-forum-session.js";

describe("readTestSurfaceId", () => {
  it("reads a positive integer correlation", () => {
    expect(readTestSurfaceId(JSON.stringify({ test_surface_id: 7 }))).toBe(7);
  });

  it("rejects malformed metadata and invalid identifiers", () => {
    expect(readTestSurfaceId("{")).toBeNull();
    expect(readTestSurfaceId(JSON.stringify({ test_surface_id: 0 }))).toBeNull();
    expect(readTestSurfaceId(JSON.stringify({ test_surface_id: "7" }))).toBeNull();
  });
});
