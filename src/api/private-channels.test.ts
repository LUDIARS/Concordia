import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrivateChannelsRepo } from "../db/private-channels-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { privateChannelsRouter } from "./private-channels.js";

function makeApp(admin: string | null = "123456789012345678") {
  const repo = new PrivateChannelsRepo(makeTestDb());
  const events: ConcordiaEvent[] = [];
  const app = new Hono().route("/v1/discord/private-channels", privateChannelsRouter({
    repo, adminUserId: () => admin, emit: (event) => { events.push(event); }, now: () => 7_000,
  }));
  return { app, repo, events };
}

const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("privateChannelsRouter", () => {
  it("accepts a request, asks the bot to create it, and answers the same key with the same record", async () => {
    const { app, events } = makeApp();
    const first = await app.request("/v1/discord/private-channels", post({ name: "Report", key: "k-1", text: "hi" }));
    expect(first.status).toBe(202);
    const body = await first.json() as { id: string; status: string; url: string | null };
    expect(body).toMatchObject({ status: "pending", url: null });
    expect(events).toEqual([expect.objectContaining({ type: "discord.private_channel.requested", private_channel_id: body.id, ts: 7 })]);

    const again = await app.request("/v1/discord/private-channels", post({ name: "Report", key: "k-1" }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(body.id);
    expect(events).toHaveLength(1);
  });

  it("reports status and the url once ready", async () => {
    const { app, repo } = makeApp();
    const { id } = await (await app.request("/v1/discord/private-channels", post({ name: "Report" }))).json() as { id: string };
    repo.recordChannel(id, { guild_id: "g-1", channel_id: "c-1" });
    repo.markReady(id);
    expect(await (await app.request(`/v1/discord/private-channels/${id}`)).json())
      .toMatchObject({ status: "ready", url: "https://discord.com/channels/g-1/c-1" });
    expect((await app.request("/v1/discord/private-channels/missing")).status).toBe(404);
  });

  it("rejects requests without viewers", async () => {
    const { app } = makeApp(null);
    const res = await app.request("/v1/discord/private-channels", post({ name: "Report" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_viewers" });
  });
});
