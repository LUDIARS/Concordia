import { describe, expect, it } from "vitest";
import { bountyIntakeKey, initialBountyStatus, missingBountyIntakeFields, normalizeBountyIntake } from "./intake.js";

const fields = normalizeBountyIntake({
  project: " Cc ",
  what_happened: "  /spawn の応答が返らず、スレッドが作られない  ",
  repro_steps: "1. /spawn を実行する\n2. 30 秒待つ",
});

describe("normalizeBountyIntake", () => {
  it("trims the fields and treats a blank project as unknown", () => {
    expect(fields).toEqual({
      project: "Cc",
      what_happened: "/spawn の応答が返らず、スレッドが作られない",
      repro_steps: "1. /spawn を実行する\n2. 30 秒待つ",
    });
    expect(normalizeBountyIntake({ project: "  ", what_happened: null })).toEqual({
      project: null, what_happened: "", repro_steps: "",
    });
  });
});

describe("initialBountyStatus (bug-bounty.md §3)", () => {
  it("accepts a report without the description as needs_info and asks for it once", () => {
    expect(initialBountyStatus({ what_happened: "  " })).toBe("needs_info");
    expect(missingBountyIntakeFields({ what_happened: "" })).toEqual(["what_happened"]);
  });

  it("receives a described report even when the project is unknown", () => {
    expect(initialBountyStatus(normalizeBountyIntake({ project: null, what_happened: "壊れている" }))).toBe("received");
    expect(missingBountyIntakeFields({ what_happened: "壊れている" })).toEqual([]);
  });
});

describe("bountyIntakeKey (CC-BOUNTY-INV-02)", () => {
  it("uses the interaction id for Discord and the Cocoiru report id for Cocoiru", () => {
    expect(bountyIntakeKey({ platform: "discord", clientKey: "1422334455", sessionId: null, fields })).toBe("discord:1422334455");
    expect(bountyIntakeKey({ platform: "cocoiru", clientKey: "coco-7", sessionId: null, fields })).toBe("cocoiru:coco-7");
  });

  it("requires a key from Discord and Cocoiru", () => {
    expect(bountyIntakeKey({ platform: "discord", clientKey: null, sessionId: null, fields })).toBeNull();
    expect(bountyIntakeKey({ platform: "cocoiru", clientKey: "  ", sessionId: null, fields })).toBeNull();
  });

  it("pairs a session's client key with the session id", () => {
    expect(bountyIntakeKey({ platform: "session", clientKey: "retry-1", sessionId: "sess-a", fields }))
      .toBe("session:sess-a:key:retry-1");
    expect(bountyIntakeKey({ platform: "session", clientKey: "retry-1", sessionId: "sess-b", fields }))
      .not.toBe(bountyIntakeKey({ platform: "session", clientKey: "retry-1", sessionId: "sess-a", fields }));
  });

  it("falls back to a hash of the text for a session and never carries the text itself", () => {
    const key = bountyIntakeKey({ platform: "session", clientKey: null, sessionId: "sess-a", fields });
    expect(key).toMatch(/^session:sess-a:body:[0-9a-f]{64}$/);
    expect(key).not.toContain(fields.what_happened);
    expect(bountyIntakeKey({ platform: "session", clientKey: null, sessionId: "sess-a", fields })).toBe(key);
    expect(bountyIntakeKey({
      platform: "session", clientKey: null, sessionId: "sess-a", fields: { ...fields, repro_steps: "別の手順" },
    })).not.toBe(key);
  });
});
