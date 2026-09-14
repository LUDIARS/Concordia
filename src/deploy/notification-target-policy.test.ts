import { describe, expect, it } from "vitest";
import {
  isSubsidiaryInPolicyScope,
  parseNotificationPolicy,
  serializeNotificationPolicy,
  type ProjectNotificationPolicy,
} from "./notification-target-policy.js";

const policy = (overrides: Partial<ProjectNotificationPolicy> = {}): ProjectNotificationPolicy => ({
  enabled: true,
  hq: true,
  subsidiaryScope: "none",
  subsidiaryIds: [],
  ...overrides,
});
const candidate = { subsidiaryId: "glab", enabled: true, projects: ["concordia"] };
const disabled = policy({ enabled: false, hq: false });

describe("project notification policy", () => {
  it("treats a missing stored value as unset so the current delivery rules stay in effect", () => {
    expect(parseNotificationPolicy(null)).toBeNull();
    expect(parseNotificationPolicy(undefined)).toBeNull();
  });

  it("reads an unreadable explicit value as disabled rather than falling back to the current rules", () => {
    expect(parseNotificationPolicy("{broken")).toEqual(disabled);
    expect(parseNotificationPolicy(JSON.stringify({ enabled: true, hq: true, subsidiary_scope: "everyone", subsidiary_ids: [] })))
      .toEqual(disabled);
  });

  it("round-trips a policy and keeps subsidiary ids only for the selected scope", () => {
    const selected = serializeNotificationPolicy(policy({ hq: false, subsidiaryScope: "selected", subsidiaryIds: [" glab ", "glab", "pagus"] }));
    expect(parseNotificationPolicy(selected)).toEqual(policy({ hq: false, subsidiaryScope: "selected", subsidiaryIds: ["glab", "pagus"] }));
    const all = serializeNotificationPolicy(policy({ subsidiaryScope: "all", subsidiaryIds: ["glab"] }));
    expect(parseNotificationPolicy(all)?.subsidiaryIds).toEqual([]);
  });

  it("resolves each subsidiary scope against enabled subsidiaries only", () => {
    expect(isSubsidiaryInPolicyScope(policy(), "Concordia", candidate)).toBe(false);
    expect(isSubsidiaryInPolicyScope(policy({ subsidiaryScope: "operating" }), "Concordia", candidate)).toBe(true);
    expect(isSubsidiaryInPolicyScope(policy({ subsidiaryScope: "operating" }), "Pagus", candidate)).toBe(false);
    expect(isSubsidiaryInPolicyScope(policy({ subsidiaryScope: "all" }), "Pagus", candidate)).toBe(true);
    expect(isSubsidiaryInPolicyScope(policy({ subsidiaryScope: "selected", subsidiaryIds: ["glab"] }), "Pagus", candidate)).toBe(true);
    expect(isSubsidiaryInPolicyScope(policy({ subsidiaryScope: "selected", subsidiaryIds: ["pagus"] }), "Pagus", candidate)).toBe(false);
    expect(isSubsidiaryInPolicyScope(policy({ subsidiaryScope: "all" }), "Concordia", { ...candidate, enabled: false })).toBe(false);
  });

  it("includes no subsidiary while the event is disabled", () => {
    expect(isSubsidiaryInPolicyScope(policy({ enabled: false, subsidiaryScope: "all" }), "Concordia", candidate)).toBe(false);
  });
});
