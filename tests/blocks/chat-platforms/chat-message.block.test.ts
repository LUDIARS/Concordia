// @augur test: chat ingress persists a message through the HTTP boundary
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../../helpers/test-app.js";

describe("chat-platforms block", () => {
  it("accepts chat ingress and makes the persisted message available to the transport-facing read route", async () => {
    const env = makeTestApp();
    const posted = await env.app.request("/v1/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "chitchat", text: "block message", author_label: "fixture" }) });
    expect(posted.status).toBe(200);
    const listed = await (await env.app.request("/v1/chat?channel=chitchat")).json() as { messages: Array<{ text: string }> };
    expect(listed.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "block message" })]));
  });
});
