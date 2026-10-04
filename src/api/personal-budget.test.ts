import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createPersonalBudget, type PersonalBudgetServices } from "../personal-budget/composition.js";
import { personalBudgetRouter } from "./personal-budget.js";

let budget: PersonalBudgetServices;
let app: Hono;

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

beforeEach(() => {
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: (id) => (id === "glab" ? 1_000_000 : null),
    isGlobalOver: () => false,
    readSetting: () => null,
  });
  app = new Hono().route("/v1/personal-budget", personalBudgetRouter({
    people: budget.people,
    ledger: budget.ledger,
    view: budget.view,
    adjustments: budget.adjustments,
    subsidiaryExists: (id) => id === "glab" || id === "vantan",
  }));
});

describe("GET /v1/personal-budget/people", () => {
  it("pages people with their monthly allowance and reward balance", async () => {
    for (let i = 0; i < 3; i += 1) {
      budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: `10${i}` }, `user-${i}`);
    }
    budget.people.ensure({ subsidiaryId: "vantan", platform: "discord", platformUserId: "900" }, "zed");
    const first = budget.people.find({ subsidiaryId: "glab", platform: "discord", platformUserId: "100" })!;
    budget.ledger.grant({ personId: first.id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000 });

    const page = await (await app.request("/v1/personal-budget/people?limit=2&offset=0")).json() as {
      people: Array<Record<string, unknown>>; total: number; limit: number; offset: number;
    };
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 0 });
    expect(page.people).toHaveLength(2);
    expect(page.people[0]).toMatchObject({
      id: first.id, subsidiary_id: "glab", display_name: "user-0", monthly_token_limit_override: null,
      monthly_limit: 1_000_000, monthly_used: 0, monthly_remaining: 1_000_000, reward_balance: 300_000,
    });

    const vantan = await (await app.request("/v1/personal-budget/people?subsidiary_id=vantan")).json() as {
      people: Array<Record<string, unknown>>; total: number;
    };
    expect(vantan.total).toBe(1);
    expect(vantan.people[0]).toMatchObject({ display_name: "zed", monthly_limit: 0, monthly_remaining: null });
  });

  it("falls back to a bounded page for unreadable paging parameters", async () => {
    const page = await (await app.request("/v1/personal-budget/people?limit=100000&offset=-3")).json() as { limit: number; offset: number };
    expect(page).toMatchObject({ limit: 200, offset: 0 });
  });
});

describe("GET /v1/personal-budget/people/:id/ledger", () => {
  it("returns one person's ledger, paged, and 404 for an unknown person", async () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "100" });
    for (let i = 0; i < 3; i += 1) budget.ledger.grant({ personId: person.id, kind: "bounty", sourceRef: `bug-${i}`, tokens: 10, now: 1_000 + i });
    const other = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "200" });
    budget.ledger.grant({ personId: other.id, kind: "bounty", sourceRef: "bug-other", tokens: 10 });

    const page = await (await app.request(`/v1/personal-budget/people/${person.id}/ledger?limit=2`)).json() as {
      entries: Array<{ source_ref: string; entry_type: string }>; total: number;
    };
    expect(page.total).toBe(3);
    expect(page.entries.map((entry) => entry.source_ref)).toEqual(["bug-2", "bug-1"]);
    expect((await app.request("/v1/personal-budget/people/pbp_missing/ledger")).status).toBe(404);
  });
});

describe("PUT /v1/personal-budget/people/:id/monthly-limit", () => {
  it("sets and clears the personal monthly limit", async () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "100" });
    const set = await app.request(`/v1/personal-budget/people/${person.id}/monthly-limit`, json("PUT", { monthly_token_limit: 250_000 }));
    expect(await set.json()).toMatchObject({ person: { monthly_token_limit_override: 250_000, monthly_limit: 250_000 } });

    const cleared = await app.request(`/v1/personal-budget/people/${person.id}/monthly-limit`, json("PUT", { monthly_token_limit: null }));
    expect(await cleared.json()).toMatchObject({ person: { monthly_token_limit_override: null, monthly_limit: 1_000_000 } });
  });

  it("rejects invalid limits and unknown people", async () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "100" });
    const path = `/v1/personal-budget/people/${person.id}/monthly-limit`;
    expect((await app.request(path, json("PUT", { monthly_token_limit: -1 }))).status).toBe(400);
    expect((await app.request(path, json("PUT", { monthly_token_limit: 1.5 }))).status).toBe(400);
    expect((await app.request(path, json("PUT", {}))).status).toBe(400);
    expect((await app.request("/v1/personal-budget/people/pbp_missing/monthly-limit", json("PUT", { monthly_token_limit: 1 }))).status).toBe(404);
  });
});

describe("POST /v1/personal-budget/adjustments", () => {
  it("adjusts an existing person and records the WebUI as the actor", async () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "100" });
    const res = await app.request("/v1/personal-budget/adjustments", json("POST", { person_id: person.id, tokens: 500_000, reason: "勉強会の登壇" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ person_id: person.id, reward_balance: 500_000, entry: { tokens: 500_000, reason: "勉強会の登壇" } });
    expect(budget.ledger.listForPerson(person.id, { limit: 1, offset: 0 }).entries[0]).toMatchObject({ entry_type: "manual", actor: "webui" });
  });

  it("enrolls a person named by company and user id, but only in a registered subsidiary", async () => {
    const ok = await app.request("/v1/personal-budget/adjustments", json("POST", {
      subsidiary_id: "vantan", platform: "discord", platform_user_id: "777", tokens: 100, reason: "お礼",
    }));
    expect(ok.status).toBe(200);
    expect(budget.people.find({ subsidiaryId: "vantan", platform: "discord", platformUserId: "777" })).not.toBeNull();

    const unknown = await app.request("/v1/personal-budget/adjustments", json("POST", {
      subsidiary_id: "nowhere", platform: "discord", platform_user_id: "777", tokens: 100, reason: "お礼",
    }));
    expect(unknown.status).toBe(404);
  });

  it("refuses an adjustment without a reason, without a target, and a reduction of an empty balance", async () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "100" });
    const noReason = await app.request("/v1/personal-budget/adjustments", json("POST", { person_id: person.id, tokens: 100, reason: "  " }));
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toMatchObject({ error: "reason_required" });

    expect((await app.request("/v1/personal-budget/adjustments", json("POST", { tokens: 100, reason: "x" }))).status).toBe(400);
    expect((await app.request("/v1/personal-budget/adjustments", json("POST", { person_id: person.id, tokens: 0, reason: "x" }))).status).toBe(400);

    const empty = await app.request("/v1/personal-budget/adjustments", json("POST", { person_id: person.id, tokens: -10, reason: "減額" }));
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({ error: "nothing_to_reduce" });
    expect((await app.request("/v1/personal-budget/adjustments", json("POST", { person_id: "pbp_missing", tokens: 1, reason: "x" }))).status).toBe(404);
    expect(budget.ledger.listForPerson(person.id, { limit: 10, offset: 0 }).total).toBe(0);
  });
});
