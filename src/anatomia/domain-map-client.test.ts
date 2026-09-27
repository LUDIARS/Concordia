import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchPlanOkf, searchDomainMap } from "./domain-map-client.js";

describe("domain-map client verified endpoint", () => {
  it("routes search and plan to the verified base instead of the environment default", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(request.url?.startsWith("/api/domain-map/search")
        ? JSON.stringify({ query: "task", hits: [{ project: "verified-id", kind: "content", name: "owned", paths: [] }] })
        : JSON.stringify({ okf: "verified plan" }));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const result = await searchDomainMap("task", { baseUrl });
      const plan = await fetchPlanOkf("verified-id", "task", { baseUrl });
      expect(result?.hits[0]?.project).toBe("verified-id");
      expect(plan).toBe("verified plan");
      expect(paths).toEqual([expect.stringContaining("/api/domain-map/search"), "/api/plan"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
