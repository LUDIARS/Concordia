import { describe, expect, it } from "vitest";
import {
  matchesTaskflowOrganizationScope,
  parseTaskflowOrganizationScope,
  resolveTaskflowSubsidiary,
} from "./subsidiary-scope.js";

describe("taskflow subsidiary scope", () => {
  it("parses all, head-office, and subsidiary scopes without a sentinel ID", () => {
    expect(parseTaskflowOrganizationScope({})).toEqual({ ok: true, scope: { kind: "all" } });
    expect(parseTaskflowOrganizationScope({ headOffice: "1" }))
      .toEqual({ ok: true, scope: { kind: "head_office" } });
    expect(parseTaskflowOrganizationScope({ subsidiaryId: " sub-1 " }))
      .toEqual({ ok: true, scope: { kind: "subsidiary", subsidiaryId: "sub-1" } });
    expect(parseTaskflowOrganizationScope({ subsidiaryId: "sub-1", headOffice: "1" }))
      .toEqual({ ok: false, error: "conflicting_organization_scope" });
    expect(parseTaskflowOrganizationScope({ subsidiaryId: "x".repeat(121) }))
      .toEqual({ ok: false, error: "invalid_subsidiary_id" });
  });

  it("matches null ownership only as head office", () => {
    expect(matchesTaskflowOrganizationScope(null, { kind: "head_office" })).toBe(true);
    expect(matchesTaskflowOrganizationScope("sub-1", { kind: "head_office" })).toBe(false);
    expect(matchesTaskflowOrganizationScope("sub-1", { kind: "subsidiary", subsidiaryId: "sub-1" })).toBe(true);
  });

  it("propagates linked ownership and rejects conflicting evidence", () => {
    expect(resolveTaskflowSubsidiary({
      explicit: undefined,
      references: [{ kind: "delegation_run", id: "run-1", found: true, subsidiaryId: "sub-1" }],
    })).toEqual({ ok: true, subsidiaryId: "sub-1" });
    expect(resolveTaskflowSubsidiary({
      explicit: "sub-2",
      references: [{ kind: "source_session", id: "session-1", found: true, subsidiaryId: "sub-1" }],
    })).toEqual({ ok: false, error: "conflicting_subsidiary_ownership" });
  });
});
