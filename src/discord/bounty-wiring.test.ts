import { describe, expect, it, vi } from "vitest";
import { createBountyFlowDeps, type BountyWiringDeps } from "./bounty-wiring.js";

const NECO = "905235114026467350";
/** Bot の内部トークンをヘッダで付ける (CC-BOUNTY-INV-10)。 */
const OPERATOR = { "x-concordia-bounty-operator": "bot-token" };
const values = { project: "Cc", what_happened: "壊れている", repro_steps: "", public_name: "" };

function setup(response: unknown, overrides: Partial<BountyWiringDeps> = {}) {
  const callConcordia = vi.fn(async () => response);
  const flow = createBountyFlowDeps({
    runtimeSubsidiaryId: null,
    callConcordia,
    operatorToken: () => "bot-token",
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
    }, OPERATOR);
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
    }), OPERATOR);
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
    }, OPERATOR);
    const withdrawn = setup({ ...receiptBody, status: "withdrawn" });
    expect(await withdrawn.flow.withdraw({ reportId: "br/abc", userId: NECO }))
      .toMatchObject({ ok: true, receipt: { status: "withdrawn" } });
    expect(withdrawn.callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reports/br%2Fabc/withdraw", {
      platform: "discord", actor: { user_id: NECO, subsidiary_id: null },
    }, OPERATOR);
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

describe("createBountyFlowDeps follow-up calls (bug-bounty.md §5 §7)", () => {
  it("amends, appeals and closes through the API with the operator key", async () => {
    const amended = setup({ ...receiptBody, status: "received" });
    expect(await amended.flow.amend({ reportId: "br_abc", userId: NECO, whatHappened: "追記", reproSteps: "" }))
      .toMatchObject({ ok: true, receipt: { status: "received" } });
    expect(amended.callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reports/br_abc/amend", {
      platform: "discord", actor: { user_id: NECO, subsidiary_id: null }, what_happened: "追記", repro_steps: "",
    }, OPERATOR);
    const appealed = setup({ ok: true });
    expect(await appealed.flow.appeal({ reportId: "br_abc", userId: NECO, reason: "再現します" })).toEqual({ ok: true });
    expect(appealed.callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reports/br_abc/appeal", {
      platform: "discord", actor: { user_id: NECO, subsidiary_id: null }, reason: "再現します",
    }, OPERATOR);
    const closed = setup({ error: "not_authority" });
    expect(await closed.flow.close({ reportId: "br_abc", userId: NECO, evidence: "反映を確認" }))
      .toEqual({ ok: false, error: "not_authority" });
  });

  it("sends no operator header when the Bot cannot read its token (Cc then refuses with 403)", async () => {
    const { flow, callConcordia } = setup(receiptBody, { operatorToken: () => null });
    await flow.withdraw({ reportId: "br_abc", userId: NECO });
    expect(callConcordia).toHaveBeenCalledWith("POST", "/v1/bounty/reports/br_abc/withdraw", expect.anything(), {});
  });
});
