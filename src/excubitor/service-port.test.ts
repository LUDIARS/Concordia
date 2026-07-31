import { describe, expect, it } from "vitest";

import { resolveServicePort } from "./service-port.js";

describe("resolveServicePort", () => {
  it("prefers the observed runtime port", () => {
    expect(resolveServicePort({ port: 4240, catalog_snapshot: { port: 9999 } })).toBe(4240);
  });

  // 実例: revisor は state=running でも top-level port が null で返る。
  it("falls back to the catalog port when the runtime port is missing", () => {
    expect(resolveServicePort({ port: null, catalog_snapshot: { port: 4240 } })).toBe(4240);
    expect(resolveServicePort({ catalog_snapshot: { port: 4240 } })).toBe(4240);
  });

  it("rejects ports outside the valid range instead of returning them", () => {
    expect(resolveServicePort({ port: 0, catalog_snapshot: { port: 70_000 } })).toBeNull();
    expect(resolveServicePort({ port: 1.5, catalog_snapshot: null })).toBeNull();
  });

  it("returns null when nothing usable is present", () => {
    expect(resolveServicePort(null)).toBeNull();
    expect(resolveServicePort(undefined)).toBeNull();
    expect(resolveServicePort({})).toBeNull();
  });
});
