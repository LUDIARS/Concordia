import Database from "better-sqlite3";
import type { ButtonInteraction, TextChannel } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { TeamsRepo } from "../db/teams-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import {
  buildTeamAdminControlId,
  buildTeamAdminPanel,
  handleTeamAdminInteraction,
  parseTeamAdminControlId,
  upsertTeamAdminPanelMessage,
} from "./team-admin-panel.js";

const noopLog = { info: () => {}, warn: () => {} };

function makeRepo(): { db: Database.Database; repo: TeamsRepo } {
  const db = new Database(":memory:");
  applyMigrations(db);
  return { db, repo: new TeamsRepo(db) };
}

function fakeButton(customId: string, userId = "user-1"): ButtonInteraction & { replies: unknown[] } {
  const replies: unknown[] = [];
  return {
    customId,
    user: { id: userId },
    isButton: () => true,
    isStringSelectMenu: () => false,
    reply: async (payload: unknown) => { replies.push(payload); },
    replies,
  } as unknown as ButtonInteraction & { replies: unknown[] };
}

describe("parseTeamAdminControlId", () => {
  const teamId = `team_${"a".repeat(32)}`;

  it("組み立てた customId を往復できる", () => {
    expect(parseTeamAdminControlId(buildTeamAdminControlId("suspend", teamId)))
      .toEqual({ action: "suspend", teamId });
    expect(parseTeamAdminControlId(buildTeamAdminControlId("resume", teamId)))
      .toEqual({ action: "resume", teamId });
  });

  it("別 namespace・未知 action・不正 team id は null", () => {
    expect(parseTeamAdminControlId(`ctrl:suspend:${teamId}`)).toBeNull();
    expect(parseTeamAdminControlId(`teamadm:archive:${teamId}`)).toBeNull();
    expect(parseTeamAdminControlId("teamadm:suspend:evil id")).toBeNull();
    expect(parseTeamAdminControlId("teamadm:suspend:team_short")).toBeNull();
    expect(parseTeamAdminControlId("teamadm:suspend")).toBeNull();
  });
});

describe("buildTeamAdminPanel", () => {
  it("稼働中は一時停止ボタン、停止中は再開ボタンを出す", () => {
    const { db, repo } = makeRepo();
    const running = repo.create({ name: "Running", slug: "running" });
    const stopped = repo.create({ name: "Stopped", slug: "stopped" });
    repo.setSuspended(stopped.id, true);

    const panel = buildTeamAdminPanel(repo.list());
    const embed = panel.embeds[0].toJSON();
    expect(embed.description).toContain("🟢 **Running**");
    expect(embed.description).toContain("⏸ **Stopped**");

    const buttons = panel.components.flatMap((row) => row.toJSON().components) as Array<{ custom_id: string; label: string }>;
    expect(buttons.map((b) => b.custom_id).sort()).toEqual([
      buildTeamAdminControlId("suspend", running.id),
      buildTeamAdminControlId("resume", stopped.id),
    ].sort());
    db.close();
  });

  it("チーム 0 件でも空パネルを描画できる (ボタン無し)", () => {
    const panel = buildTeamAdminPanel([]);
    expect(panel.components).toHaveLength(0);
    expect(panel.embeds[0].toJSON().description).toContain("登録されていません");
  });
});

describe("upsertTeamAdminPanelMessage", () => {
  it("保存済みメッセージを更新する", async () => {
    const edit = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => ({ edit }));
    const send = vi.fn(async () => ({ id: "new-message" }));
    const channel = { messages: { fetch }, send } as unknown as TextChannel;
    const configSet = vi.fn();
    const panel = buildTeamAdminPanel([]);

    await upsertTeamAdminPanelMessage(channel, panel, () => "message-1", configSet);

    expect(fetch).toHaveBeenCalledWith("message-1");
    expect(edit).toHaveBeenCalledWith({ embeds: panel.embeds, components: panel.components });
    expect(send).not.toHaveBeenCalled();
    expect(configSet).not.toHaveBeenCalled();
  });

  it("保存済みメッセージが取得できなければ作り直して id を保存する", async () => {
    const fetch = vi.fn(async () => { throw new Error("missing"); });
    const send = vi.fn(async () => ({ id: "new-message" }));
    const channel = { messages: { fetch }, send } as unknown as TextChannel;
    const configSet = vi.fn();
    const panel = buildTeamAdminPanel([]);

    await upsertTeamAdminPanelMessage(channel, panel, () => "missing-message", configSet);

    expect(send).toHaveBeenCalledWith({ embeds: panel.embeds, components: panel.components });
    expect(configSet).toHaveBeenCalledWith("team_admin_panel_message_id", "new-message");
  });
});

describe("handleTeamAdminInteraction", () => {
  let events: ConcordiaEvent[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    events = [];
    unsubscribe = eventBus.subscribe((ev) => {
      if (ev.type === "team.changed") events.push(ev);
    });
  });
  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  it("権限があれば一時停止し、team.changed を流す", async () => {
    const { db, repo } = makeRepo();
    const team = repo.create({ name: "IdleTeam", slug: "idle-team" });
    const interaction = fakeButton(buildTeamAdminControlId("suspend", team.id));

    await handleTeamAdminInteraction(interaction, {
      teams: repo,
      isSuspendUserAllowed: () => true,
      log: noopLog,
    });

    expect(repo.find(team.id)?.suspended_at).toEqual(expect.any(Number));
    expect(events).toHaveLength(1);
    expect((interaction.replies[0] as { content: string }).content).toContain("一時停止しました");
    db.close();
  });

  it("権限が無い / 未注入なら deny (fail-closed) で状態を変えない", async () => {
    const { db, repo } = makeRepo();
    const team = repo.create({ name: "IdleTeam", slug: "idle-team" });

    const denied = fakeButton(buildTeamAdminControlId("suspend", team.id));
    await handleTeamAdminInteraction(denied, {
      teams: repo,
      isSuspendUserAllowed: () => false,
      log: noopLog,
    });
    const uninjected = fakeButton(buildTeamAdminControlId("suspend", team.id));
    await handleTeamAdminInteraction(uninjected, { teams: repo, log: noopLog });

    expect(repo.find(team.id)?.suspended_at).toBeNull();
    expect(events).toHaveLength(0);
    expect((denied.replies[0] as { content: string }).content).toContain("session_end 権限");
    expect((uninjected.replies[0] as { content: string }).content).toContain("session_end 権限");
    db.close();
  });

  it("既に同じ状態なら team.changed を流さない (冪等)", async () => {
    const { db, repo } = makeRepo();
    const team = repo.create({ name: "IdleTeam", slug: "idle-team" });
    repo.setSuspended(team.id, true);
    const interaction = fakeButton(buildTeamAdminControlId("suspend", team.id));

    await handleTeamAdminInteraction(interaction, {
      teams: repo,
      isSuspendUserAllowed: () => true,
      log: noopLog,
    });

    expect(events).toHaveLength(0);
    expect(repo.find(team.id)?.suspended_at).toEqual(expect.any(Number));
    db.close();
  });

  it("消えたチームは案内だけ返す", async () => {
    const { db, repo } = makeRepo();
    const interaction = fakeButton(buildTeamAdminControlId("resume", `team_${"b".repeat(32)}`));

    await handleTeamAdminInteraction(interaction, {
      teams: repo,
      isSuspendUserAllowed: () => true,
      log: noopLog,
    });

    expect(events).toHaveLength(0);
    expect((interaction.replies[0] as { content: string }).content).toContain("存在しません");
    db.close();
  });
});
