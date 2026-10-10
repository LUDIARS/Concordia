import { describe, expect, it } from "vitest";
import { authorizeConfirmer, capPermissions } from "./confirmation-policy.js";
import type { GoalActor } from "./domain.js";

const none = { merge: false, test: false, service: false, deploy: false };
const actor = (patch: Partial<GoalActor> = {}): GoalActor => ({
  platform: "discord", userId: "u1", guildId: "g", channelId: "c", isBot: false, isWebhook: false, role: null, ...patch,
});

describe("authorizeConfirmer (CC-DG-INV-01 / CC-DG-INV-04)", () => {
  it("rejects bots and webhooks", () => {
    expect(authorizeConfirmer(actor({ isBot: true }), none).ok).toBe(false);
    expect(authorizeConfirmer(actor({ isWebhook: true }), none).ok).toBe(false);
  });

  it("lets staff register without merge/deploy but requires a manager to allow them", () => {
    expect(authorizeConfirmer(actor(), { ...none, test: true }).ok).toBe(true);
    expect(authorizeConfirmer(actor(), { ...none, merge: true }).ok).toBe(false);
    expect(authorizeConfirmer(actor({ role: "manager" }), { ...none, deploy: true }).ok).toBe(true);
  });
});

describe("capPermissions (受け入れ基準: 許可は投稿者の権限で認められたものだけ)", () => {
  it("drops merge/deploy beyond the poster's role and keeps the rest", () => {
    expect(capPermissions(actor(), { merge: true, test: true, service: false, deploy: true }))
      .toEqual({ permissions: { merge: false, test: true, service: false, deploy: false }, dropped: ["merge", "deploy"] });
  });

  it("keeps everything for a manager", () => {
    const all = { merge: true, test: true, service: true, deploy: true };
    expect(capPermissions(actor({ role: "manager" }), all)).toEqual({ permissions: all, dropped: [] });
  });
});
