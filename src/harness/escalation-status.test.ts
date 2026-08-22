import { describe, expect, it } from "vitest";
import { formatEscalationBadge, formatEscalationField } from "./escalation-status.js";

describe("escalation status card", () => {
  it("shows nothing while the session is running normally", () => {
    expect(formatEscalationBadge(null)).toBeNull();
    expect(formatEscalationBadge({ active: false, reason: null, started_at: null })).toBeNull();
    expect(formatEscalationField({ active: false, reason: "old", started_at: 1 })).toBeNull();
  });

  it("shows the reason, the elapsed time, and what is still forbidden", () => {
    const field = formatEscalationField({ active: true, reason: "Cc down", started_at: 1_000 }, 8_200);

    expect(formatEscalationBadge({ active: true, reason: "Cc down", started_at: 1_000 })).toContain("エスカレーション中");
    expect(field).toContain("Cc down");
    expect(field).toContain("2時間経過");
    expect(field).toContain("GitHub 直 push");
  });

  it("still renders when the reason is missing", () => {
    expect(formatEscalationField({ active: true, reason: null, started_at: null })).toContain("(理由未記録)");
  });
});
