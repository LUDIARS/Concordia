import { describe, expect, it, vi } from "vitest";
import { createBountyFlowDeps, type BountyWiringDeps } from "./bounty-wiring.js";

const NECO = "905235114026467350";
const values = { project: "Cc", what_happened: "壊れている", repro_steps: "", public_name: "" };

function setup(response: unknown, overrides: Partial<BountyWiringDeps> = {}) {
  const callConcordia = vi.fn(async () => response);
  const flow = createBountyFlowDeps({
    runtimeSubsidiaryId: null,
    callConcordia,
    registeredProjects: () => [{ code: "Cc", project: "Concordia" }, { code: "At", project: "Actio" }],
    companyProjects: () => null,
    publicNameOf: (userId) => (userId === NECO ? "neco" : null),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  });
  return { flow, callConcordia };
}

const receiptBody = {
  report_id: "br_abc", status: "received", project: "Cc", missing: [], reporter: "匿名", has_recipient: true, created: true,
};

describe("createBountyFlowDeps (bug-bounty.md §3)", () => {
  it("submits through the Cc intake API as the Discord operator of this Bot's company", async () => {
    const { flow, callConcordia } = setup(receiptBody, { runtimeSubsidiaryId: "sub_a" });
    const result = await flow.submit({ clientKey: "1001", userId: NECO, guildId: "77777", channelId: "88888", values });
    expect(callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reports", {
      platform: "discord",
      actor: { user_id: NECO, subsidiary_id: "sub_a" },
      client_key: "1001",
      project: "Cc",
      what_happened: "壊れている",
      repro_steps: "",
      reply_to: { guild_id: "77777", channel_id: "88888" },
    });
    expect(result).toEqual({
      ok: true, created: true,
      receipt: { report_id: "br_abc", status: "received", project: "Cc", missing: [], reporter: "匿名", has_recipient: true },
    });
  });

  it("sends a blank project as unknown and a public name only when the reporter wrote one", async () => {
    const { flow, callConcordia } = setup(receiptBody);
    await flow.submit({
      clientKey: "1002", userId: NECO, guildId: null, channelId: null, values: { ...values, project: "", public_name: "neco" },
    });
    expect(callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reports", expect.objectContaining({
      project: null, public_name: "neco", reply_to: {}, actor: { user_id: NECO, subsidiary_id: null },
    }));
  });

  it("passes the API error code through and refuses an unreadable response", async () => {
    const refused = setup({ error: "unknown_project" });
    expect(await refused.flow.submit({ clientKey: "1", userId: NECO, guildId: null, channelId: null, values }))
      .toEqual({ ok: false, error: "unknown_project" });
    const unreadable = setup({ status: "received" });
    expect(await unreadable.flow.submit({ clientKey: "1", userId: NECO, guildId: null, channelId: null, values }))
      .toEqual({ ok: false, error: "unreadable_response" });
    const empty = setup(null);
    expect(await empty.flow.withdraw({ reportId: "br_abc", userId: NECO })).toEqual({ ok: false, error: "unreadable_response" });
  });

  it("changes the public name and withdraws through the API", async () => {
    const named = setup({ public_name: "neco", display: "neco" });
    expect(await named.flow.setPublicName({ userId: NECO, publicName: "neco" })).toEqual({ ok: true, display: "neco" });
    expect(named.callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reporters/public-name", {
      platform: "discord", actor: { user_id: NECO, subsidiary_id: null }, public_name: "neco",
    });
    const withdrawn = setup({ ...receiptBody, status: "withdrawn" });
    expect(await withdrawn.flow.withdraw({ reportId: "br/abc", userId: NECO }))
      .toMatchObject({ ok: true, receipt: { status: "withdrawn" } });
    expect(withdrawn.callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reports/br%2Fabc/withdraw", {
      platform: "discord", actor: { user_id: NECO, subsidiary_id: null },
    });
  });

  it("offers only the company's related projects and the caller's own public name", () => {
    const headOffice = setup(receiptBody);
    expect(headOffice.flow.projects().map((project) => project.code)).toEqual(["Cc", "At"]);
    expect(headOffice.flow.currentPublicName(NECO)).toBe("neco");
    expect(headOffice.flow.currentPublicName("111111")).toBeNull();
    const subsidiary = setup(receiptBody, { runtimeSubsidiaryId: "sub_a", companyProjects: () => ["Actio"] });
    expect(subsidiary.flow.projects()).toEqual([{ code: "At", project: "Actio" }]);
  });
});
