import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";

describe("/v1/cost/one-shots", () => {
  let env: TestAppEnv;

  beforeEach(() => {
    env = makeTestApp();
  });

  it("records service CLI calls with prompt and returns summary", async () => {
    const res = await env.app.request("/v1/cost/one-shots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: 1234,
        service: "quaestor",
        provider: "claude",
        command: "claude -p --output-format json",
        model: "haiku",
        cwd: "/repo",
        prompt: "classify this receipt",
        status: "ok",
        input_tokens: 10,
        output_tokens: 5,
        cost_usd: 0.001,
        metadata: { route: "ocr" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: 1 });

    const list = await env.app.request("/v1/cost/one-shots?since=0");
    expect(list.status).toBe(200);
    const body = (await list.json()) as any;
    expect(body.calls[0]).toMatchObject({
      service: "quaestor",
      provider: "claude",
      prompt: "classify this receipt",
      totalTokens: 15,
      metadata: { route: "ocr" },
    });
    expect(body.summary[0]).toMatchObject({
      service: "quaestor",
      provider: "claude",
      calls: 1,
      totalTokens: 15,
    });
  });

  it("rejects missing prompt", async () => {
    const res = await env.app.request("/v1/cost/one-shots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "x", provider: "claude" }),
    });
    expect(res.status).toBe(400);
  });
});
