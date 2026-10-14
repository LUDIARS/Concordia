import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { DriveTransferService } from "../consultation/drive-transfer-service.js";
import { consultationDriveRouter } from "./consultation-drive.js";

function makeApp(drive: Partial<DriveTransferService>) {
  return new Hono().route("/v1/consultations", consultationDriveRouter({ drive: drive as DriveTransferService }));
}

const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("consultationDriveRouter", () => {
  it("opens the folder for the requester and returns its link", async () => {
    const open = vi.fn(async () => ({ ok: true as const, folder: { id: "f", url: "https://drive/f" }, created: true }));
    const res = await makeApp({ open }).request("/v1/consultations/pc_1/drive/open", post({ actor_user_id: "11111", email: "me@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ folder_url: "https://drive/f", created: true });
    expect(open).toHaveBeenCalledWith({ consultationId: "pc_1", actorUserId: "11111", email: "me@example.com" });
  });

  it("reports an unconfigured transfer as 503 and Drive failures with their code", async () => {
    const app = makeApp({
      open: vi.fn(async () => ({ ok: false as const, error: "drive_not_configured" as const })),
      sync: vi.fn(async () => ({ ok: false as const, error: "drive_failed" as const, detail: "unauthorized" as const })),
    });
    const opened = await app.request("/v1/consultations/pc_1/drive/open", post({ actor_user_id: "11111", email: "me@example.com" }));
    expect(opened.status).toBe(503);
    expect(await opened.json()).toEqual({ error: "drive_not_configured" });
    const synced = await app.request("/v1/consultations/pc_1/drive/sync", post({ actor_user_id: "11111" }));
    expect(synced.status).toBe(502);
    expect(await synced.json()).toEqual({ error: "drive_failed", detail: "unauthorized" });
  });

  it("returns the sync result", async () => {
    const sync = vi.fn(async () => ({
      ok: true as const,
      folder: { id: "f", url: "https://drive/f" },
      imported: [{ name: "a.wav", path: "C:/x/a.wav", kind: "audio" as const }],
      delivered: [],
      skipped: [],
    }));
    const res = await makeApp({ sync }).request("/v1/consultations/pc_1/drive/sync", post({ actor_user_id: "22222" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folder_url: "https://drive/f", imported: [{ name: "a.wav", path: "C:/x/a.wav", kind: "audio" }], delivered: [], skipped: [],
    });
  });

  it("rejects malformed requests without calling the service", async () => {
    const open = vi.fn();
    const app = makeApp({ open });
    expect((await app.request("/v1/consultations/pc_1/drive/open", post({ actor_user_id: "abc", email: "me@example.com" }))).status).toBe(400);
    expect((await app.request("/v1/consultations/pc_1/drive/open", post({ actor_user_id: "11111" }))).status).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });
});
