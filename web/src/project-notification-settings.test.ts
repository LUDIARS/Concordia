import { describe, expect, it } from "vitest";
import type { ProjectNotificationPreference, ProjectNotificationPreferenceInput } from "./api.js";
import {
  describeNotificationPreference,
  shouldSavePreference,
  toggleDeployTarget,
  toggleSubsidiary,
  unlistedDeployTargets,
} from "./project-notification-settings.js";

const preference = (overrides: Partial<ProjectNotificationPreference> = {}): ProjectNotificationPreference => ({
  configured: true,
  enabled: true,
  hq: true,
  subsidiary_scope: "none",
  subsidiary_ids: [],
  ...overrides,
});
const subsidiaryName = (id: string) => (id === "sub-a" ? "glab" : id);

describe("project notification settings view model", () => {
  it("summarises explicit, disabled and unset settings", () => {
    expect(describeNotificationPreference(preference(), subsidiaryName)).toBe("本社");
    expect(describeNotificationPreference(preference({ subsidiary_scope: "operating" }), subsidiaryName)).toBe("本社＋運用対象の子会社");
    expect(describeNotificationPreference(preference({ hq: false, subsidiary_scope: "selected", subsidiary_ids: ["sub-a"] }), subsidiaryName)).toBe("glab");
    expect(describeNotificationPreference(preference({ enabled: false, subsidiary_scope: "all" }), subsidiaryName)).toBe("通知しない");
    expect(describeNotificationPreference(preference({ configured: false }), subsidiaryName)).toBe("未設定 (現行規則)");
  });

  it("saves an unset event once touched and skips an unchanged explicit event", () => {
    const draft: ProjectNotificationPreferenceInput = { enabled: true, hq: true, subsidiary_scope: "operating", subsidiary_ids: [] };
    expect(shouldSavePreference(preference({ configured: false, subsidiary_scope: "operating" }), draft, true)).toBe(true);
    expect(shouldSavePreference(preference({ subsidiary_scope: "operating" }), draft, true)).toBe(false);
    expect(shouldSavePreference(preference({ configured: false }), draft, false)).toBe(false);
  });

  it("edits subsidiaries and named destinations without raw JSON", () => {
    expect(toggleSubsidiary(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleSubsidiary(["a", "b"], "a", false)).toEqual(["b"]);
    expect(toggleDeployTarget([], { kind: "slack", target: "slack" }, true)).toEqual([{ kind: "slack", target: "slack" }]);
    expect(unlistedDeployTargets([{ kind: "discord", target: "discord" }, { kind: "discord", target: "legacy" }]))
      .toEqual([{ kind: "discord", target: "legacy" }]);
  });
});
