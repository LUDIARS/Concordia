import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { TeamsRepo } from "../db/teams-repo.js";
import { postTeamAuditCard } from "./team-audit-card.js";

function makeDb() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function makeGuild(channel: { send: ReturnType<typeof vi.fn> } | null) {
  return {
    channels: {
      fetch: vi.fn(async () => channel ? { isTextBased: () => true, send: channel.send } : null),
    },
  } as any;
}

const log = { info: vi.fn(), warn: vi.fn() };

describe("postTeamAuditCard", () => {
  it("posts once to the team's direction surface", async () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Alpha", slug: "alpha" });
    db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, 'direction', 'chan-direction')").run(team.id);
    const send = vi.fn(async () => undefined);
    const guild = makeGuild({ send });

    await postTeamAuditCard(
      { guild, teamsRepo: repo, log },
      { kind: "created", eventId: "created-1", teamId: team.id, name: team.name, slug: team.slug, ts: 1 },
    );

    expect(guild.channels.fetch).toHaveBeenCalledWith("chan-direction");
    expect(send).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("does not repost the same event on redelivery/restart (idempotent)", async () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Beta", slug: "beta" });
    db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, 'direction', 'chan-direction')").run(team.id);
    const send = vi.fn(async () => undefined);
    const guild = makeGuild({ send });
    const input = { kind: "changed" as const, eventId: "changed-1", teamId: team.id, fields: ["rules_text"], ts: 42 };

    await postTeamAuditCard({ guild, teamsRepo: repo, log }, input);
    await postTeamAuditCard({ guild, teamsRepo: repo, log }, input);

    expect(send).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("posts distinct same-second changes with the same fields", async () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Beta", slug: "beta" });
    db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, 'direction', 'chan-direction')").run(team.id);
    const send = vi.fn(async () => undefined);
    const guild = makeGuild({ send });

    await postTeamAuditCard(
      { guild, teamsRepo: repo, log },
      { kind: "changed", eventId: "changed-1", teamId: team.id, fields: ["rules_text"], ts: 42 },
    );
    await postTeamAuditCard(
      { guild, teamsRepo: repo, log },
      { kind: "changed", eventId: "changed-2", teamId: team.id, fields: ["rules_text"], ts: 42 },
    );

    expect(send).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("skips safely without throwing when the direction surface is not provisioned", async () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Gamma", slug: "gamma" });
    const send = vi.fn(async () => undefined);
    const guild = makeGuild({ send });

    await expect(postTeamAuditCard(
      { guild, teamsRepo: repo, log },
      { kind: "created", eventId: "created-1", teamId: team.id, name: team.name, slug: team.slug, ts: 1 },
    )).resolves.toBeUndefined();

    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    db.close();
  });

  it("does not consume the dedupe claim when the surface is missing, so a later provision can still post", async () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Delta", slug: "delta" });
    const send = vi.fn(async () => undefined);

    await postTeamAuditCard(
      { guild: makeGuild(null), teamsRepo: repo, log },
      { kind: "created", eventId: "created-1", teamId: team.id, name: team.name, slug: team.slug, ts: 1 },
    );

    db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, 'direction', 'chan-direction')").run(team.id);
    const guild = makeGuild({ send });
    await postTeamAuditCard(
      { guild, teamsRepo: repo, log },
      { kind: "created", eventId: "created-1", teamId: team.id, name: team.name, slug: team.slug, ts: 1 },
    );

    expect(send).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("does not post from a subsidiary bot", async () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Epsilon", slug: "epsilon" });
    db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, 'direction', 'chan-direction')").run(team.id);
    const send = vi.fn(async () => undefined);
    const guild = makeGuild({ send });

    await postTeamAuditCard(
      { guild, teamsRepo: repo, log, subsidiary: true },
      { kind: "created", eventId: "created-1", teamId: team.id, name: team.name, slug: team.slug, ts: 1 },
    );

    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    db.close();
  });
});
