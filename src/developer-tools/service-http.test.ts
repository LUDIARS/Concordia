import { describe, expect, it, vi } from "vitest";
import { ToolServiceHttp, boundedJson } from "./service-http.js";
import type { ExcubitorClient } from "../excubitor/client.js";
describe("catalog-backed HTTP tools", () => {
  it("uses the declared port and forbids redirects", async () => {
    const catalog = { findService: vi.fn(async () => ({ state: "running", catalog_snapshot: { port: 1234 }, port: 9999 })) };
    const fetchImpl = vi.fn(async () => new Response('{"projects":[]}'));
    await new ToolServiceHttp(catalog as unknown as ExcubitorClient, fetchImpl).request("anatomia", "/api/projects");
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:1234/api/projects", expect.objectContaining({ redirect: "error" }));
  });
  it("reports missing authentication and does not fall back to another endpoint", async () => {
    const catalog = { findService: vi.fn(async () => ({ state: "running", catalog_snapshot: { port: 1234 } })) };
    const fetchImpl = vi.fn(async () => new Response("secret detail", { status: 401 }));
    await expect(new ToolServiceHttp(catalog as unknown as ExcubitorClient, fetchImpl).request("praeforma", "/api/projects"))
      .rejects.toThrow("authentication_required");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("bounds the response body", async () => {
    await expect(boundedJson(new Response('"large"'), 2)).rejects.toThrow("response too large");
  });
});
