import { describe, expect, it } from "vitest";
import { controlSessionRouter, type ControlSessionApiDeps } from "./control-session.js";

function app(patch: Partial<ControlSessionApiDeps> = {}) {
  const dispatched: unknown[] = [];
  const router = controlSessionRouter({
    isEnabled: () => true,
    holder: () => ({ spawn_id: "sp", generation: 4, spawned_at: 10, retired: [] }),
    currentControlSessionId: () => "ctl",
    boardRows: () => [],
    dispatch: async (input) => { dispatched.push(input); return { delivered: input.targets, skipped: [] }; },
    ...patch,
  });
  const post = (body: unknown) => router.request("/instructions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { router, post, dispatched };
}

describe("/v1/control", () => {
  it("reports status and the board", async () => {
    const { router } = app();
    expect(await (await router.request("/status")).json()).toEqual({ enabled: true, generation: 4, spawned_at: 10, control_session_id: "ctl" });
    expect(await (await router.request("/board")).json()).toEqual({ items: [], external_bridges: [] });
  });

  it("accepts instructions only from the current control session (CC-CTL-INV-06)", async () => {
    const a = app();
    const ok = await a.post({ from_session_id: "ctl", targets: ["w1", "ctl"], text: "続けて" });
    expect(ok.status).toBe(200);
    expect(a.dispatched).toEqual([{ targets: ["w1"], text: "続けて", origin: { kind: "control", generation: 4 } }]);
    const denied = await a.post({ from_session_id: "someone", targets: ["w1"], text: "x" });
    expect(denied.status).toBe(403);
    expect(a.dispatched).toHaveLength(1);
  });

  it("rejects malformed instructions", async () => {
    const a = app();
    expect((await a.post({ from_session_id: "ctl", targets: [], text: "x" })).status).toBe(400);
    expect((await a.post({ from_session_id: "ctl", targets: ["w"], text: "  " })).status).toBe(400);
  });

  it("returns control_disabled while OFF", async () => {
    const a = app({ isEnabled: () => false });
    expect((await a.router.request("/board")).status).toBe(409);
    expect((await a.post({ from_session_id: "ctl", targets: ["w"], text: "x" })).status).toBe(409);
    expect(await (await a.router.request("/status")).json()).toMatchObject({ enabled: false, control_session_id: null });
  });
});
