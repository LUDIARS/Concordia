import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { openTestingClaim, releaseTestingClaims } from "./claim-lifecycle.js";

type ClaimEvent = Extract<
  ConcordiaEvent,
  { type: "operational.claim.opened" | "operational.claim.released" }
>;

describe("testing claim lifecycle", () => {
  it("claim と release を公開イベントにする", () => {
    const repo = new TestingClaimsRepo(makeTestDb());
    const events: ClaimEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "operational.claim.opened" || event.type === "operational.claim.released") {
        events.push(event);
      }
    });

    try {
      openTestingClaim(repo, {
        service: "concordia",
        sessionId: "s1",
        branch: "feat/claim-posts",
        note: "restart check",
        now: 100,
      });
      expect(releaseTestingClaims(repo, { sessionId: "s1", now: 110 })).toBe(1);
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.type)).toEqual([
      "operational.claim.opened",
      "operational.claim.released",
    ]);
    expect(events[0]).toMatchObject({
      target_session_id: "s1",
      resource: "concordia",
      branch: "feat/claim-posts",
      note: "restart check",
    });
  });

  it("再宣言は旧 claim の解放後に新 claim を公開する", () => {
    const repo = new TestingClaimsRepo(makeTestDb());
    const events: ClaimEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "operational.claim.opened" || event.type === "operational.claim.released") {
        events.push(event);
      }
    });

    try {
      openTestingClaim(repo, { service: "concordia", sessionId: "s1", note: "old", now: 100 });
      events.length = 0;
      openTestingClaim(repo, { service: "concordia", sessionId: "s1", note: "new", now: 110 });
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.type)).toEqual([
      "operational.claim.released",
      "operational.claim.opened",
    ]);
    expect(events[1]).toMatchObject({ note: "new" });
  });
});
