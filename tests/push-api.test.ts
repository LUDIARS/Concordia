import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

const VALID_SUBSCRIPTION = {
  endpoint: "https://push.example.test/subscriptions/browser-client",
  keys: {
    p256dh: "BExampleBase64UrlPublicKey012345678901234567890123456789012345678901234567890123456789",
    auth: "ExampleAuthSecret012345",
  },
};

describe("push API", () => {
  it("rejects non-HTTPS subscription endpoints", async () => {
    const env = makeTestApp();

    const response = await env.app.request("/v1/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "browser-client",
        subscription: {
          endpoint: "http://127.0.0.1:11111/internal",
          keys: { p256dh: "key", auth: "auth" },
        },
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects an HTTPS IP-literal endpoint to prevent server-side requests to internal services", async () => {
    const env = makeTestApp();
    const response = await env.app.request("/v1/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "browser-client",
        subscription: { ...VALID_SUBSCRIPTION, endpoint: "https://127.0.0.1/internal" },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects cross-origin and simple-content subscription mutations", async () => {
    const env = makeTestApp();
    const body = JSON.stringify({ client_id: "browser-client", subscription: VALID_SUBSCRIPTION });
    const simpleResponse = await env.app.request("/v1/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    expect(simpleResponse.status).toBe(415);

    const crossOriginResponse = await env.app.request("/v1/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body,
    });
    expect(crossOriginResponse.status).toBe(403);
  });

  it("stores a bounded public push subscription without returning its credentials", async () => {
    const env = makeTestApp();
    const response = await env.app.request("/v1/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "browser-client", subscription: VALID_SUBSCRIPTION }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(env.db.prepare("SELECT client_id FROM web_push_subscriptions WHERE endpoint = ?").get(VALID_SUBSCRIPTION.endpoint)).toEqual({
      client_id: "browser-client",
    });
  });

  it("only deletes a subscription for its owning browser client", async () => {
    const env = makeTestApp();
    env.db.prepare(
      "INSERT INTO web_push_subscriptions(endpoint, client_id, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    ).run(VALID_SUBSCRIPTION.endpoint, "browser-client", VALID_SUBSCRIPTION.keys.p256dh, VALID_SUBSCRIPTION.keys.auth);

    const deleteSubscription = (clientId: string) => env.app.request("/v1/push/subscriptions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, endpoint: VALID_SUBSCRIPTION.endpoint }),
    });
    expect((await deleteSubscription("different-client")).status).toBe(200);
    expect(env.db.prepare("SELECT COUNT(*) AS count FROM web_push_subscriptions").get()).toEqual({ count: 1 });
    expect((await deleteSubscription("browser-client")).status).toBe(200);
    expect(env.db.prepare("SELECT COUNT(*) AS count FROM web_push_subscriptions").get()).toEqual({ count: 0 });
  });
});
