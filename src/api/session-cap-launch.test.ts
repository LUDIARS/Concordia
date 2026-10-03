/**
 * @implements spec/feature/usage-budgets.md §9
 * 起動の入口 (`POST /v1/delegation/invoke` の spawn・`POST /v1/spawn`) が会社のセッション上限で
 * 起動を断り、 理由を `session_cap_reached:` 付きで返すことを確かめる。
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { delegationRouter } from "./delegation.js";
import { spawnRouter } from "./spawn.js";
import { ensureSpawnToken } from "../control/token.js";
import type { DelegationService } from "../delegation/service.js";
import type { InvokeInput } from "../delegation/contracts.js";

const REFUSED = { allowed: false as const, reason: "本社のセッション上限 (30) に達しています。" };

describe("delegation invoke session cap", () => {
  function makeApp(decide: (subsidiaryId: string | null) => { allowed: true } | typeof REFUSED) {
    const calls: InvokeInput[] = [];
    const companies: Array<string | null> = [];
    const service = {
      invoke: async (input: InvokeInput) => { calls.push(input); return { ok: false, error: "x" }; },
    } as unknown as DelegationService;
    const app = new Hono().route("/v1/delegation", delegationRouter({
      repo: new DelegationRepo(makeTestDb()),
      service,
      checkSessionCap: (subsidiaryId) => { companies.push(subsidiaryId); return decide(subsidiaryId); },
    }));
    const invoke = (body: unknown) => app.request("/v1/delegation/invoke", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { invoke, calls, companies };
  }

  it("refuses a spawning invoke when the company is at its cap, without reaching the service", async () => {
    const { invoke, calls, companies } = makeApp(() => REFUSED);
    const res = await invoke({ call_name: "impl", args: {}, spawn: true, subsidiary_id: "sub-1" });
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBe(`session_cap_reached: ${REFUSED.reason}`);
    expect(companies).toEqual(["sub-1"]);
    expect(calls).toEqual([]);
  });

  it("does not judge an invoke that does not spawn a session", async () => {
    const { invoke, calls, companies } = makeApp(() => REFUSED);
    await invoke({ call_name: "impl", args: {} });
    expect(companies).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("counts a head-office invoke against the head office", async () => {
    const { invoke, calls, companies } = makeApp(() => ({ allowed: true }));
    await invoke({ call_name: "impl", args: {}, spawn: true });
    expect(companies).toEqual([null]);
    expect(calls).toHaveLength(1);
  });
});

describe("/v1/spawn session cap", () => {
  it("refuses with 429 and the reason when the head office is at its cap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-spawn-cap-"));
    const token = ensureSpawnToken(cwd);
    const app = new Hono().route("/v1/spawn", spawnRouter({ cwd, checkSessionCap: () => REFUSED }));
    const res = await app.request("/v1/spawn", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBe(`session_cap_reached: ${REFUSED.reason}`);
  });
});
