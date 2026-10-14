import { describe, expect, it } from "vitest";
import {
  bountyEventPhase,
  bountyEventRewardOverride,
  matchBountyEvent,
  validateBountyEventDraft,
  type BountyEvent,
} from "./event-policy.js";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const event = (overrides: Partial<BountyEvent> = {}): BountyEvent => ({
  id: "be_a",
  title: "秋のバグ探し",
  startsAt: NOW - HOUR,
  endsAt: NOW + HOUR,
  projects: ["Cc", "Ar"],
  channels: ["discord", "session"],
  guidance: "通知まわりを重点的に",
  rewardOverride: { s1: 2_000_000 },
  endedEarlyAt: null,
  ...overrides,
});

describe("bountyEventPhase (bug-bounty.md §18.2)", () => {
  it("is scheduled before the start, open inside the period and ended from the end or an early end", () => {
    expect(bountyEventPhase(event({ startsAt: NOW + 1 }), NOW)).toBe("scheduled");
    expect(bountyEventPhase(event(), NOW)).toBe("open");
    expect(bountyEventPhase(event({ endsAt: NOW }), NOW)).toBe("ended");
    expect(bountyEventPhase(event({ endedEarlyAt: NOW - 1 }), NOW)).toBe("ended");
  });
});

describe("matchBountyEvent (CC-BOUNTY-INV-11)", () => {
  const base = { project: "Cc", platform: "session" as const, eventId: null, now: NOW };

  it("links a report to the open event that targets its project and intake channel", () => {
    expect(matchBountyEvent({ ...base, events: [event()] })).toEqual({ ok: true, event: event() });
  });

  it("gives no event (and keeps the intake going) outside the period, project or channel, or with no project", () => {
    expect(matchBountyEvent({ ...base, events: [event({ startsAt: NOW + 1 })] })).toEqual({ ok: true, event: null });
    expect(matchBountyEvent({ ...base, events: [event({ endedEarlyAt: NOW })] })).toEqual({ ok: true, event: null });
    expect(matchBountyEvent({ ...base, project: "At", events: [event()] })).toEqual({ ok: true, event: null });
    // コードは大文字小文字を区別する (project registry と同じ)。
    expect(matchBountyEvent({ ...base, project: "CC", events: [event()] })).toEqual({ ok: true, event: null });
    expect(matchBountyEvent({ ...base, platform: "cocoiru", events: [event()] })).toEqual({ ok: true, event: null });
    expect(matchBountyEvent({ ...base, project: null, events: [event()] })).toEqual({ ok: true, event: null });
  });

  it("picks the event that ends first when events overlap, and honours an explicit event id", () => {
    const later = event({ id: "be_later", endsAt: NOW + 3 * HOUR });
    const sooner = event({ id: "be_sooner", endsAt: NOW + 2 * HOUR });
    expect(matchBountyEvent({ ...base, events: [later, sooner] })).toMatchObject({ ok: true, event: { id: "be_sooner" } });
    expect(matchBountyEvent({ ...base, eventId: "be_later", events: [later, sooner] })).toMatchObject({ ok: true, event: { id: "be_later" } });
  });

  it("refuses an explicit event id that is not a candidate", () => {
    expect(matchBountyEvent({ ...base, eventId: "be_missing", events: [event()] })).toEqual({ ok: false, error: "event_not_applicable" });
    expect(matchBountyEvent({ ...base, project: "At", eventId: "be_a", events: [event()] }))
      .toEqual({ ok: false, error: "event_not_applicable" });
  });
});

describe("validateBountyEventDraft (bug-bounty.md §18.3)", () => {
  const registeredCodes = ["Cc", "Ar", "At"];
  const draft = {
    title: " 秋のバグ探し ", startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR, projects: ["Cc", "Cc", "Ar"],
    channels: ["session", "discord"], guidance: "通知まわり", rewardOverride: { s2: 300 },
  };

  it("normalizes a valid draft", () => {
    expect(validateBountyEventDraft({ draft, current: null, registeredCodes, now: NOW })).toEqual({
      ok: true,
      value: {
        title: "秋のバグ探し", startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR, projects: ["Cc", "Ar"],
        channels: ["discord", "session"], guidance: "通知まわり", rewardOverride: { s2: 300 },
      },
    });
  });

  it.each([
    [{ title: "" }, "title_invalid"],
    [{ title: "改行\nあり" }, "title_invalid"],
    [{ guidance: "`code`" }, "guidance_invalid"],
    [{ endsAt: NOW + HOUR }, "period_invalid"],
    [{ projects: [] }, "projects_invalid"],
    [{ projects: ["Zz"] }, "unknown_project"],
    [{ channels: [] }, "channels_invalid"],
    [{ channels: ["slack"] }, "channels_invalid"],
    [{ rewardOverride: { s1: -1 } }, "reward_override_invalid"],
    [{ rewardOverride: { s5: 1 } }, "reward_override_invalid"],
  ])("refuses %j with %s", (change, error) => {
    expect(validateBountyEventDraft({ draft: { ...draft, ...change }, current: null, registeredCodes, now: NOW }))
      .toEqual({ ok: false, error });
  });

  it("keeps a started event's projects and start, and refuses to edit an ended event", () => {
    const started = event();
    expect(validateBountyEventDraft({ draft: { projects: ["Cc"] }, current: started, registeredCodes, now: NOW }))
      .toEqual({ ok: false, error: "event_projects_reduced" });
    expect(validateBountyEventDraft({ draft: { startsAt: NOW - 2 * HOUR }, current: started, registeredCodes, now: NOW }))
      .toEqual({ ok: false, error: "event_started" });
    expect(validateBountyEventDraft({ draft: { projects: ["Cc", "Ar", "At"], endsAt: NOW + 5 * HOUR }, current: started, registeredCodes, now: NOW }))
      .toMatchObject({ ok: true, value: { projects: ["Cc", "Ar", "At"], endsAt: NOW + 5 * HOUR, rewardOverride: { s1: 2_000_000 } } });
    expect(validateBountyEventDraft({ draft: { title: "延長" }, current: event({ endsAt: NOW }), registeredCodes, now: NOW }))
      .toEqual({ ok: false, error: "event_ended" });
  });

  it("lets a scheduled event change its start and drop projects, and clears the override with null", () => {
    const scheduled = event({ startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR });
    expect(validateBountyEventDraft({
      draft: { startsAt: NOW + 30 * 60_000, projects: ["Cc"], rewardOverride: null }, current: scheduled, registeredCodes, now: NOW,
    })).toMatchObject({ ok: true, value: { startsAt: NOW + 30 * 60_000, projects: ["Cc"], rewardOverride: null } });
  });
});

describe("bountyEventRewardOverride (bug-bounty.md §18.4)", () => {
  it("returns the override for the report's severity and null otherwise", () => {
    expect(bountyEventRewardOverride(event(), "s1")).toBe(2_000_000);
    expect(bountyEventRewardOverride(event(), "s2")).toBeNull();
    expect(bountyEventRewardOverride(event(), null)).toBeNull();
    expect(bountyEventRewardOverride(event({ rewardOverride: null }), "s1")).toBeNull();
    expect(bountyEventRewardOverride(null, "s1")).toBeNull();
    expect(bountyEventRewardOverride(event({ rewardOverride: { s3: 0 } }), "s3")).toBe(0);
  });
});
