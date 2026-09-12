import { describe, expect, it, vi } from "vitest";
import {
  composeProjectCreatedNotice,
  handleProjectPushed,
  type ProjectCreatedEvent,
  type ProjectNoticeLedger,
} from "./project-created.js";

const event: ProjectCreatedEvent = {
  repository: "LUDIARS/Stilus",
  code: "St",
  project: "Stilus",
  repoUrl: "https://github.com/LUDIARS/Stilus",
};

/** 台帳の実体は sqlite だが、通知方針の判定は claim の結果だけで決まる。 */
function ledgerWith(armed: ProjectCreatedEvent | null): ProjectNoticeLedger & { claims: number } {
  let remaining = armed;
  return {
    claims: 0,
    arm: () => true,
    claim(this: { claims: number }) {
      this.claims += 1;
      const taken = remaining;
      remaining = null;
      return taken;
    },
  } as ProjectNoticeLedger & { claims: number };
}

describe("project created notice", () => {
  it("names the repository, the code and the project on one line", () => {
    expect(composeProjectCreatedNotice(event)).toBe(
      "【LUDIARS/Stilus 新規プロジェクト】 St Stilus\nhttps://github.com/LUDIARS/Stilus",
    );
  });

  it("delivers once and skips the second push of the same repository", async () => {
    const ledger = ledgerWith(event);
    const ccChannel = vi.fn(async () => {});
    const run = () => handleProjectPushed({ repository: event.repository, ledger, channelConfigured: true,
      delivery: { ccChannel }, now: 1_000 });

    expect(await run()).toEqual({ skipped: false, unconfigured: false, delivered: true, failed: null });
    expect(await run()).toEqual({ skipped: true, unconfigured: false, delivered: false, failed: null });
    expect(ccChannel).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a repository that was never armed", async () => {
    const ccChannel = vi.fn(async () => {});
    expect(await handleProjectPushed({ repository: "LUDIARS/Concordia", ledger: ledgerWith(null),
      channelConfigured: true, delivery: { ccChannel }, now: 1_000 }))
      .toEqual({ skipped: true, unconfigured: false, delivered: false, failed: null });
    expect(ccChannel).not.toHaveBeenCalled();
  });

  it("reports an unconfigured channel instead of delivering", async () => {
    const ccChannel = vi.fn(async () => {});
    expect(await handleProjectPushed({ repository: event.repository, ledger: ledgerWith(event),
      channelConfigured: false, delivery: { ccChannel }, now: 1_000 }))
      .toEqual({ skipped: false, unconfigured: true, delivered: false, failed: null });
    expect(ccChannel).not.toHaveBeenCalled();
  });

  it("reports a delivery failure without re-arming the claim", async () => {
    const ledger = ledgerWith(event);
    const ccChannel = vi.fn(async () => { throw new Error("Discord rejected request (403)"); });
    const outcome = await handleProjectPushed({ repository: event.repository, ledger, channelConfigured: true,
      delivery: { ccChannel }, now: 1_000 });

    expect(outcome).toEqual({ skipped: false, unconfigured: false, delivered: false,
      failed: "Discord rejected request (403)" });
    expect(await handleProjectPushed({ repository: event.repository, ledger, channelConfigured: true,
      delivery: { ccChannel }, now: 2_000 })).toMatchObject({ skipped: true });
  });
});
