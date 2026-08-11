import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeSessionMessageDeliveryRepo } from "./session-message-delivery-repo.js";

describe("session message delivery repo", () => {
  it("stores one current external id per message and platform", () => {
    const repo = makeSessionMessageDeliveryRepo(makeTestDb());

    repo.put({ message_id: 1, platform: "discord", external_id: "discord-1", ts: 10 });
    repo.put({ message_id: 1, platform: "discord", external_id: "discord-2", ts: 20 });

    expect(repo.findExternalId(1, "discord")).toBe("discord-2");
    expect(repo.findExternalId(1, "slack")).toBeNull();
  });
});
