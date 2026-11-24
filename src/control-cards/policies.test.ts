import { describe, expect, it } from "vitest";
import type { CardSourceItem, ControlCard } from "./card-domain.js";
import { planCardSync } from "./card-sync-policy.js";
import {
  TRIAGE_MAX_CARDS,
  TRIAGE_MIN_INTERVAL_MS,
  TRIAGE_PARAMS_MAX_BYTES,
  buildTriageParams,
  decideTriageDispatch,
  triageFingerprint,
  validateTriageResult,
} from "./card-triage-policy.js";
import { REMINDER_MIN_INTERVAL_MS, decideReminder, neutralizeMentions, reminderMention, renderReminder } from "./reminder-policy.js";

const NOW = 1_800_000_000_000;

function item(key: string, kind: CardSourceItem["source_kind"] = "ask-card"): CardSourceItem {
  return { source_kind: kind, source_key: key, summary: `要旨 ${key}`, raised_at: NOW - 60_000, session_id: "s1", project: "Cc", link: null };
}

function card(id: string, patch: Partial<ControlCard> = {}): ControlCard {
  return {
    id, source_kind: "ask-card", source_key: id, card_kind: "human_judgment", summary: `要旨 ${id}`, session_id: "s1", project: "Cc",
    link: null, state: "open", raised_at: NOW - 3_600_000, closed_at: null, close_reason: null, priority: "normal", assignee: null,
    remind_at: NOW, reminder_text: null, card_group: null, triaged_by: null, triaged_at: null, created_at: NOW, updated_at: NOW, ...patch,
  };
}

describe("カード同期の判定 (CC-V5-INV-02 / 03)", () => {
  it("creates cards for new unresolved items and closes cards whose readable source resolved", () => {
    const plan = planCardSync({
      readings: [{ kind: "ask-card", readable: true, items: [item("a"), item("b")] }],
      openCards: [card("b", { source_key: "b", summary: "要旨 b" }), card("gone", { source_key: "gone" })],
      sessionEnded: () => false,
    });
    expect(plan.create.map((row) => row.source_key)).toEqual(["a"]);
    expect(plan.close).toEqual([{ id: "gone", reason: "source_resolved" }]);
  });

  it("keeps cards open when their source could not be read (CC-V5-INV-03)", () => {
    const plan = planCardSync({
      readings: [{ kind: "ask-card", readable: false, error: "db busy" }],
      openCards: [card("x")],
      sessionEnded: () => true,
    });
    expect(plan.close).toEqual([]);
    expect(plan.unreadable).toEqual(["ask-card"]);
  });

  it("closes card-owned human-command cards only on session end, never on a missing reading", () => {
    const owned = card("h", { source_kind: "human-command", card_kind: "human_action" });
    expect(planCardSync({ readings: [], openCards: [owned], sessionEnded: () => false }).close).toEqual([]);
    expect(planCardSync({ readings: [], openCards: [owned], sessionEnded: () => null }).close).toEqual([]);
    expect(planCardSync({ readings: [], openCards: [owned], sessionEnded: () => true }).close).toEqual([{ id: "h", reason: "session_ended" }]);
  });

  it("refreshes a changed summary without reopening", () => {
    const plan = planCardSync({
      readings: [{ kind: "ask-card", readable: true, items: [{ ...item("a"), summary: "新しい要旨" }] }],
      openCards: [card("a1", { source_key: "a" })],
      sessionEnded: () => false,
    });
    expect(plan.create).toEqual([]);
    expect(plan.refresh).toEqual([{ id: "a1", summary: "新しい要旨", link: null }]);
  });
});

describe("dots の捌き (CC-V5-INV-04)", () => {
  it("summarizes at most 20 cards, high priority and oldest first, within 8000 bytes", () => {
    const cards = Array.from({ length: 30 }, (_, index) => card(`c${index}`, {
      raised_at: NOW - index * 1000, priority: index === 29 ? "high" : "normal", summary: "長".repeat(300),
    }));
    const params = buildTriageParams(cards, NOW);
    expect(params.cards.length).toBeLessThanOrEqual(TRIAGE_MAX_CARDS);
    expect(params.cards[0]!.card_id).toBe("c29");
    expect(params.cards[1]!.card_id).toBe("c28");
    expect(params.open_total).toBe(30);
    expect(Array.from(params.cards[0]!.summary).length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(params), "utf8")).toBeLessThanOrEqual(TRIAGE_PARAMS_MAX_BYTES);
  });

  it("registers only when the open set changed, the previous instruction finished and 10 minutes passed", () => {
    const fingerprint = triageFingerprint([card("a")]);
    const base = { enabled: true, openCount: 1, fingerprint, previousFinished: true, nowMs: NOW };
    expect(decideTriageDispatch({ ...base, state: { fingerprint: null, instruction_id: null, registered_at: null } })).toEqual({ kind: "register" });
    expect(decideTriageDispatch({ ...base, state: { fingerprint, instruction_id: "i", registered_at: 0 } })).toMatchObject({ reason: "unchanged" });
    const other = { fingerprint: "old", instruction_id: "i", registered_at: NOW - TRIAGE_MIN_INTERVAL_MS - 1 };
    expect(decideTriageDispatch({ ...base, previousFinished: false, state: other })).toMatchObject({ reason: "previous_unfinished" });
    expect(decideTriageDispatch({ ...base, state: { ...other, registered_at: NOW - 1000 } })).toMatchObject({ reason: "too_soon" });
    expect(decideTriageDispatch({ ...base, enabled: false, state: other })).toMatchObject({ reason: "disabled" });
    expect(decideTriageDispatch({ ...base, openCount: 0, state: other })).toMatchObject({ reason: "no_cards" });
    expect(decideTriageDispatch({ ...base, state: other })).toEqual({ kind: "register" });
  });

  it("applies only the five triage fields and drops unknown, closed, duplicate or out-of-range entries", () => {
    const result = validateTriageResult({
      cards: [
        { card_id: "open-1", priority: "high", assignee: "123456789012345678", remind_at: new Date(NOW + 3_600_000).toISOString(), reminder_text: "見てください", group: "朝" },
        { card_id: "open-1", priority: "low" },
        { card_id: "closed-1", priority: "high" },
        { card_id: "open-2", priority: "urgent" },
        { card_id: "open-3", reminder_text: "長".repeat(401) },
        { card_id: "open-4", remind_at: "not a date" },
        { card_id: "open-5", state: "closed", answer: "yes" },
        { card_id: "open-6", remind_at: new Date(NOW - 60_000).toISOString() },
      ],
    }, new Set(["open-1", "open-2", "open-3", "open-4", "open-5", "open-6"]), NOW);
    expect(result.apply).toEqual([
      { cardId: "open-1", patch: { priority: "high", assignee: "123456789012345678", remind_at: NOW + 3_600_000, reminder_text: "見てください", card_group: "朝" } },
      // 過去の催促時刻は今に寄せる。
      { cardId: "open-6", patch: { remind_at: NOW } },
    ]);
    expect(result.dropped.map((row) => row.card_id)).toEqual(["open-1", "closed-1", "open-2", "open-3", "open-4", "open-5"]);
    expect(validateTriageResult({ nope: true }, new Set(), NOW).apply).toEqual([]);
  });
});

describe("催促 (CC-V5-INV-05)", () => {
  it("sends when due, waits at least 30 minutes between reminders and stays silent in quiet hours", () => {
    const due = card("a", { remind_at: NOW - 1 });
    expect(decideReminder({ card: due, lastSentAt: null, nowMs: NOW, quiet: false })).toEqual({ kind: "send" });
    expect(decideReminder({ card: due, lastSentAt: NOW - REMINDER_MIN_INTERVAL_MS + 1, nowMs: NOW, quiet: false })).toMatchObject({ reason: "too_soon" });
    expect(decideReminder({ card: due, lastSentAt: NOW - REMINDER_MIN_INTERVAL_MS, nowMs: NOW, quiet: false })).toEqual({ kind: "send" });
    expect(decideReminder({ card: due, lastSentAt: null, nowMs: NOW, quiet: true })).toMatchObject({ reason: "quiet_hours" });
    expect(decideReminder({ card: { ...due, remind_at: NOW + 1 }, lastSentAt: null, nowMs: NOW, quiet: false })).toMatchObject({ reason: "not_due" });
    expect(decideReminder({ card: { ...due, state: "closed" }, lastSentAt: null, nowMs: NOW, quiet: false })).toMatchObject({ reason: "closed" });
  });

  it("mentions only a structured assignee id and neutralizes mentions in the body", () => {
    expect(reminderMention("123456789012345678")).toBe("123456789012345678");
    expect(reminderMention("neco")).toBeNull();
    expect(neutralizeMentions("@everyone <@123> <@&456> @here")).not.toMatch(/@everyone|<@123>|<@&456>|@here/);
    const text = renderReminder(card("a", { reminder_text: "@everyone 確認して <@999>", assignee: "neco" }), NOW, NOW - 2 * 3_600_000);
    expect(text).toContain("2 時間経過");
    expect(text).toContain("担当: neco");
    expect(text).not.toMatch(/@everyone|<@999>/);
  });
});
