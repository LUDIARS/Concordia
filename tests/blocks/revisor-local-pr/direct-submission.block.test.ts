// @augur test: local PR submission reaches its mocked Revisor transport
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { prsRouter } from "../../../src/api/prs.js";

describe("revisor-local-pr block", () => {
  it("passes the HTTP submission request to the mocked Revisor transport", async () => {
    const transport = vi.fn(async () => ({ submitted: true as const, pullRequest: { id: "local-1", number: 1, repository: "LUDIARS/Concordia" } }));
    const app = new Hono().route("/v1/prs", prsRouter({ prs: { list: () => [] } as never, submitDirectLocalPr: transport }));
    const response = await app.request("/v1/prs/local/direct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo_path: "E:/Document/Ars/Concordia", branch: "feat/block" }) });
    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ branch: "feat/block" }));
  });
});
