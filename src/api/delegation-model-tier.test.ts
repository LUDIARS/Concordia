import { expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { delegationRouter } from "./delegation.js";
import type { DelegationService } from "../delegation/service.js";
import type { InvokeInput } from "../delegation/contracts.js";
it("validates a model level and passes it to the shared launch service", async () => {
  const calls: InvokeInput[] = [];
  const service = { invoke: async (input: InvokeInput) => {
    calls.push(input); return { ok: false, error: "test stop before spawn" };
  } } as unknown as DelegationService;
  const app = new Hono().route("/v1/delegation", delegationRouter({ repo: new DelegationRepo(makeTestDb()), service }));
  for (const tier of ["ultra", "high", "medium", "low"]) {
    await app.request("/v1/delegation/invoke", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_name: "example", model_tier: tier }) });
    expect(calls.at(-1)?.model_tier).toBe(tier);
  }
  const invalid = await app.request("/v1/delegation/invoke", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ call_name: "example", model_tier: "unlimited" }) });
  expect(invalid.status).toBe(400);
  expect(calls).toHaveLength(4);
});
