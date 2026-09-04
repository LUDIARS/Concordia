import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { StaffRepo } from "../db/staff-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { makeTestDb } from "../../tests/helpers/db.js";
import { staffRouter } from "./staff.js";

describe("staffRouter access changes", () => {
  it("emits only mutations that can change Discord management access", async () => {
    const db = makeTestDb();
    const app = new Hono().route("/v1/staff", staffRouter({ repo: new StaffRepo(db) }));
    const events: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));

    try {
      await app.request("/v1/staff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "discord",
          platform_user_id: "user-1",
          role: "manager",
        }),
      });
      await app.request("/v1/staff/discord/user-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "note-only update" }),
      });
      await app.request("/v1/staff/discord/user-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "staff" }),
      });
      await app.request("/v1/staff/discord/user-1", { method: "DELETE" });
    } finally {
      unsubscribe();
      db.close();
    }

    expect(events.filter((event) => event.type === "staff.access_changed")).toEqual([
      expect.objectContaining({ type: "staff.access_changed", platform: "discord" }),
      expect.objectContaining({ type: "staff.access_changed", platform: "discord" }),
      expect.objectContaining({ type: "staff.access_changed", platform: "discord" }),
    ]);
  });
});
