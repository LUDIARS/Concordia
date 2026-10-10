import { describe, expect, it } from "vitest";
import { authorizeConfirmer, describeMissing, parsePermissionText, validateDraft } from "./confirmation-policy.js";
import type { GoalActor } from "./domain.js";

const full = {
  project: "Concordia", repoPath: "E:/repo", goalText: "デイリーゴールを出荷する",
  acceptance: ["PR がマージされる"], actioTaskIds: ["actio:t-1"],
  permissions: { merge: false, test: false, service: false, deploy: false },
};
const actor = (patch: Partial<GoalActor> = {}): GoalActor => ({
  platform: "discord", userId: "u1", guildId: "g", channelId: "c", isBot: false, isWebhook: false, role: null, ...patch,
});

describe("validateDraft (受け入れ基準: 欠けた項目は確定せず聞き返す)", () => {
  it("accepts a complete draft and strips the actio: prefix", () => {
    const result = validateDraft(full);
    expect(result).toMatchObject({ ok: true, draft: { actioTaskIds: ["t-1"], acceptance: ["PR がマージされる"] } });
  });

  it("lists every missing field including each implicit permission", () => {
    const result = validateDraft({ project: "Concordia", repoPath: "E:/repo", goalText: " ", acceptance: [], actioTaskIds: [], permissions: { merge: true } });
    expect(result).toEqual({ ok: false, missing: ["goalText", "acceptance", "actioTaskIds", "test", "service", "deploy"] });
    if (!result.ok) expect(describeMissing(result.missing)).toContain("受入条件");
  });

  it("treats an unresolved project as missing", () => {
    expect(validateDraft({ ...full, repoPath: null })).toMatchObject({ ok: false, missing: ["project"] });
  });
});

describe("authorizeConfirmer (CC-DG-INV-01 / CC-DG-INV-04)", () => {
  it("rejects bots and webhooks", () => {
    expect(authorizeConfirmer(actor({ isBot: true }), full.permissions).ok).toBe(false);
    expect(authorizeConfirmer(actor({ isWebhook: true }), full.permissions).ok).toBe(false);
  });

  it("lets staff confirm without merge/deploy but requires a manager to allow them", () => {
    expect(authorizeConfirmer(actor(), { ...full.permissions, test: true }).ok).toBe(true);
    expect(authorizeConfirmer(actor(), { ...full.permissions, merge: true }).ok).toBe(false);
    expect(authorizeConfirmer(actor({ role: "manager" }), { ...full.permissions, deploy: true }).ok).toBe(true);
  });
});

describe("parsePermissionText", () => {
  it("reads explicit yes/no values and leaves unknown keys unset", () => {
    expect(parsePermissionText("merge=no test=yes service:不可 deploy=1 extra=yes")).toEqual({ merge: false, test: true, service: false, deploy: true });
    expect(parsePermissionText("merge=no")).toEqual({ merge: false });
  });
});
