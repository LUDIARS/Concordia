import { describe, expect, it } from "vitest";
import { renderChanges, statusPages } from "./render.js";
describe("status cards", () => {
  it("does not render a disconnected site as healthy and does not manufacture a running count", () => {
    expect(statusPages({ sites: [{ id: "a", name: "@everyone\n<site>[link](https://invalid.example)", self: false, connected: false, stale: false }], services: [], running: [] })[0])
      .toContain("稼働中: 0 サービス");
    const body = statusPages({ sites: [{ id: "a", name: "@everyone\n<site>[link](https://invalid.example)", self: false, connected: false, stale: false }], services: [], running: [] })[0]!;
    expect(body).toContain("接続断"); expect(body).not.toContain("@everyone"); expect(body).not.toContain("[link](");
  });
  it("renders unknown observations separately from stop events", () => {
    expect(renderChanges([{ siteId: "a", code: "cc", name: "Cc", before: "up", after: "unknown" }], { sites: [], services: [], running: [] })[0]).toContain("稼働 → 未確認");
  });
});
