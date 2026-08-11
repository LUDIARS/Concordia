import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { WebPushRepo } from "./web-push-repo.js";

const SUBSCRIPTION = {
  endpoint: "https://push.example.test/subscription",
  client_id: "browser-client",
  p256dh: "public-key",
  auth: "auth-key",
};

describe("WebPushRepo", () => {
  it("resets the consecutive failure counter after a successful delivery", () => {
    const repo = new WebPushRepo(makeTestDb());
    repo.upsert(SUBSCRIPTION, 1);
    repo.recordFailure(SUBSCRIPTION.endpoint, 2);
    repo.recordFailure(SUBSCRIPTION.endpoint, 3);
    expect(repo.listActive()[0]?.fail_count).toBe(2);

    repo.recordSuccess(SUBSCRIPTION.endpoint);
    expect(repo.listActive()[0]?.fail_count).toBe(0);
  });

  it("disables a subscription after five consecutive failures", () => {
    const repo = new WebPushRepo(makeTestDb());
    repo.upsert(SUBSCRIPTION, 1);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      repo.recordFailure(SUBSCRIPTION.endpoint, attempt + 2);
    }
    expect(repo.listActive()).toEqual([]);
  });
});
