import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { startManagementRemoteListener, type ManagementRemoteHandle } from "./remote-listener.js";
import { ManagementRepository } from "./repository.js";
import { ManagementService } from "./service.js";

const handles: ManagementRemoteHandle[] = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.close(); });

function service(): { service: ManagementService; token: string } {
  let n = 0;
  const svc = new ManagementService(new ManagementRepository(makeTestDb()), {
    now: () => 1_000, id: () => `id-${++n}`, newToken: () => `tok-${++n}`, hashToken: (t) => `h:${t}`,
    inject: vi.fn(), liveSessions: () => [], departmentExists: () => true,
  });
  const { token } = svc.createMission({ name: "CDGD", project_codes: ["KD"], goal: "g", allowed_kinds: ["discussion"] });
  return { service: svc, token };
}

describe("dots remote listener (CC-MGMT-07)", () => {
  it("serves only the dots operations on its own port", async () => {
    const { service: svc, token } = service();
    const handle = await startManagementRemoteListener({ host: "127.0.0.1", port: 0 }, svc);
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await fetch(`${base}/v1/management/context`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${base}/v1/management/context`)).status).toBe(401);
    expect((await fetch(`${base}/v1/admin/management/missions`)).status).toBe(404);
    expect((await fetch(`${base}/v1/management/events`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(404);
  });

  it("rejects the start when the port is taken", async () => {
    const { service: svc } = service();
    const first = await startManagementRemoteListener({ host: "127.0.0.1", port: 0 }, svc);
    handles.push(first);
    await expect(startManagementRemoteListener({ host: "127.0.0.1", port: first.port }, svc)).rejects.toThrow();
  });
});
