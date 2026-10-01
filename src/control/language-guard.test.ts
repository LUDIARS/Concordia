import { describe, expect, it, vi } from "vitest";
import { eventBus, type ConcordiaEvent } from "../events.js";
import {
  LANGUAGE_GUARD_COOLDOWN_SEC,
  LANGUAGE_GUARD_SOURCE,
  LANGUAGE_GUARD_TEXT,
  createLanguageGuard,
  startLanguageGuard,
} from "./language-guard.js";

const ENGLISH = "Checking the current state first, then I will fix the session registration so the gate lets the commands through.";
const JAPANESE = "日本語に戻しました。登録を直してから続きを進めます。";

function setup(options: { enabled?: boolean; active?: boolean; pending?: boolean } = {}) {
  let now = 1_000;
  const inject = vi.fn();
  const guard = createLanguageGuard({
    isEnabled: () => options.enabled ?? true,
    isActiveSession: () => options.active ?? true,
    hasPendingQuestion: () => options.pending ?? false,
    inject,
    now: () => now,
  });
  return { guard, inject, advance: (sec: number) => { now += sec; }, now: () => now };
}

describe("createLanguageGuard (CC-LANG-INV-02)", () => {
  it("injects the Japanese correction once when an English note appears", () => {
    const ctx = setup();
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    expect(ctx.inject).toHaveBeenCalledTimes(1);
    expect(ctx.inject).toHaveBeenCalledWith("s-1", LANGUAGE_GUARD_TEXT, ctx.now());
  });

  it("re-arms after Japanese returns, but keeps the cooldown", () => {
    const ctx = setup();
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    ctx.guard.onAssistantText("s-1", JAPANESE, ctx.now());
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    expect(ctx.inject).toHaveBeenCalledTimes(1);
    ctx.advance(LANGUAGE_GUARD_COOLDOWN_SEC);
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    expect(ctx.inject).toHaveBeenCalledTimes(2);
  });

  it("re-arms after a human instruction arrives", () => {
    const ctx = setup();
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    ctx.advance(LANGUAGE_GUARD_COOLDOWN_SEC);
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    expect(ctx.inject).toHaveBeenCalledTimes(1);
    ctx.guard.onHumanInject("s-1");
    ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
    expect(ctx.inject).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when disabled, inactive, waiting for an answer, or on replayed frames", () => {
    for (const options of [{ enabled: false }, { active: false }, { pending: true }]) {
      const ctx = setup(options);
      ctx.guard.onAssistantText("s-1", ENGLISH, ctx.now());
      expect(ctx.inject).not.toHaveBeenCalled();
    }
    const replay = setup();
    replay.guard.onAssistantText("s-1", ENGLISH, replay.now() - 3_600);
    expect(replay.inject).not.toHaveBeenCalled();
  });

  it("does not inject for Japanese text", () => {
    const ctx = setup();
    ctx.guard.onAssistantText("s-1", JAPANESE, ctx.now());
    expect(ctx.inject).not.toHaveBeenCalled();
  });
});

describe("startLanguageGuard", () => {
  it("watches assistant frames on the event bus and emits a session.inject", () => {
    const appendEvent = vi.fn();
    const emitted: ConcordiaEvent[] = [];
    const tap = eventBus.subscribe((ev) => {
      if (ev.type === "session.inject" && ev.source === LANGUAGE_GUARD_SOURCE) emitted.push(ev);
    });
    const handle = startLanguageGuard({
      repo: { findSession: () => ({ status: "active" }) as never, appendEvent },
      isEnabled: () => true,
      now: () => 2_000,
    });
    try {
      eventBus.emit({ type: "transcript.frame", target_session_id: "s-9", seq: 1, kind: "text", payload: { role: "user", text: ENGLISH }, ts: 2_000 });
      expect(emitted).toHaveLength(0);
      eventBus.emit({ type: "transcript.frame", target_session_id: "s-9", seq: 2, kind: "text", payload: { role: "assistant", text: ENGLISH, phase: "commentary" }, ts: 2_000 });
      expect(emitted).toEqual([expect.objectContaining({ target_session_id: "s-9", text: LANGUAGE_GUARD_TEXT })]);
      expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ session_id: "s-9", kind: "inject" }));
    } finally {
      handle.stop();
      tap();
    }
  });
});
