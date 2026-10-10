import { describe, expect, it, vi } from "vitest";
import dailyGoalCommand, { confirmReply, draftFromInteraction, splitIds, splitLines } from "./daily-goal.js";
import type { DiscordCommandDeps } from "../command-port.js";

function interaction(values: Record<string, string | boolean | null>, user = { id: "neco", bot: false }) {
  return {
    id: "i-1", guildId: "g", channelId: "c", user,
    options: {
      getString: (name: string) => (typeof values[name] === "string" ? values[name] : null),
      getBoolean: (name: string) => (typeof values[name] === "boolean" ? values[name] : null),
    },
    reply: vi.fn(async () => undefined),
  };
}

describe("/co-daily-goal", () => {
  it("parses acceptance lines, Actio IDs and the four explicit permissions", () => {
    expect(splitLines("A\nB; C\n")).toEqual(["A", "B", "C"]);
    expect(splitIds("actio:t1, t2 t3")).toEqual(["t1", "t2", "t3"]);
    const draft = draftFromInteraction(interaction({ project: "Cc", goal: "g", acceptance: "A;B", actio_tasks: "t1", merge: false, test: true }) as never);
    expect(draft).toEqual({ project: "Cc", goalText: "g", acceptance: ["A", "B"], actioTaskIds: ["t1"], permissions: { merge: false, test: true, service: null, deploy: null } });
  });

  it("asks back for missing fields instead of confirming", () => {
    const text = confirmReply({ ok: false, kind: "missing", missing: ["acceptance", "deploy"] }, () => 0);
    expect(text).toContain("確定していません");
    expect(text).toContain("受入条件");
    expect(text).toContain("反映の可否");
  });

  it("confirms with the interaction user and launches immediately after 07:30", async () => {
    const confirm = vi.fn(() => ({ ok: true, created: true, goal: { id: "g1", confirmedAt: 0, date: "2026-10-10" } }));
    const launchSoon = vi.fn();
    const port = { isEnabled: () => true, confirm, launchSoon, launchAtFor: () => new Date(2026, 9, 10, 7, 30).getTime() };
    const i = interaction({ project: "Cc" });
    await dailyGoalCommand.execute(i as never, { dailyGoals: port } as unknown as DiscordCommandDeps);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ receiptId: "i-1", actor: expect.objectContaining({ userId: "neco", isBot: false }) }));
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, content: expect.stringContaining("07:30") }));
    expect(launchSoon).toHaveBeenCalledTimes(1);
  });

  it("refuses when the workflow is disabled or unwired", async () => {
    const i = interaction({});
    await dailyGoalCommand.execute(i as never, {} as DiscordCommandDeps);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("使えません") }));
  });
});
