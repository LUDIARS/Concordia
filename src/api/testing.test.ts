import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { REPLACEMENT_CHAR } from "../shared/text-integrity.js";
import { testingRouter } from "./testing.js";

function setup() {
  const db = makeTestDb();
  return testingRouter({ claims: new TestingClaimsRepo(db), sessions: new SessionsRepo(db) });
}

function claim(app: ReturnType<typeof setup>, note: string) {
  return app.request("/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "s-1", service: "test-service", note }),
  });
}

describe("POST /v1/testing/claim note の文字化けガード", () => {
  it("rejects a note whose bytes were destroyed in transport", async () => {
    const app = setup();
    const res = await claim(app, `test ${REPLACEMENT_CHAR}${REPLACEMENT_CHAR} note`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe("invalid_body");
    // 直し方まで返さないと、呼び出し元は同じ壊れ方で再送してしまう。
    expect(body.detail.fieldErrors.note?.join("")).toContain("--data-binary");
  });

  it("does not persist the rejected claim", async () => {
    const app = setup();
    await claim(app, REPLACEMENT_CHAR);
    const res = await app.request("/");
    expect(await res.json()).toEqual({ claims: [] });
  });

  it("stores intact Japanese notes unchanged", async () => {
    const app = setup();
    const note = "日本語を含むテスト用のメモ";
    const res = await claim(app, note);
    expect(res.status).toBe(200);
    const body = await res.json() as { claim: { note: string } };
    expect(body.claim.note).toBe(note);
  });
});
