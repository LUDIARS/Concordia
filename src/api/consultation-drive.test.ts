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
  it("returns the service account address to share with, and links the requester's folder", async () => {
    const guide = vi.fn(() => ({ ok: true as const, serviceAccountEmail: "cc@p.iam.gserviceaccount.com" }));
    const link = vi.fn(async () => ({ ok: true as const, folder: { id: "f", url: "https://drive/f" }, relinked: false }));
    const app = makeApp({ guide, link });
    const guided = await app.request("/v1/consultations/pc_1/drive/guide", post({ actor_user_id: "11111" }));
    expect(guided.status).toBe(200);
    expect(await guided.json()).toEqual({ service_account_email: "cc@p.iam.gserviceaccount.com" });
    const linked = await app.request("/v1/consultations/pc_1/drive/link", post({ actor_user_id: "11111", folder: "https://drive.google.com/drive/folders/1AbCdEfGhIj" }));
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({ folder_url: "https://drive/f", relinked: false });
    expect(link).toHaveBeenCalledWith({ consultationId: "pc_1", actorUserId: "11111", folder: "https://drive.google.com/drive/folders/1AbCdEfGhIj" });
  });

  it("reports an unconfigured transfer as 503, unusable folders as 409 and Drive failures with their code", async () => {
    const app = makeApp({
      guide: vi.fn(() => ({ ok: false as const, error: "drive_not_configured" as const })),
      link: vi.fn(async () => ({ ok: false as const, error: "folder_read_only" as const })),
      sync: vi.fn(async () => ({ ok: false as const, error: "drive_failed" as const, detail: "unauthorized" as const })),
    });
    const guided = await app.request("/v1/consultations/pc_1/drive/guide", post({ actor_user_id: "11111" }));
    expect(guided.status).toBe(503);
    expect(await guided.json()).toEqual({ error: "drive_not_configured" });
    const linked = await app.request("/v1/consultations/pc_1/drive/link", post({ actor_user_id: "11111", folder: "1AbCdEfGhIjK" }));
    expect(linked.status).toBe(409);
    expect(await linked.json()).toEqual({ error: "folder_read_only" });
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
    const link = vi.fn();
    const app = makeApp({ link });
    expect((await app.request("/v1/consultations/pc_1/drive/link", post({ actor_user_id: "abc", folder: "1AbCdEfGhIjK" }))).status).toBe(400);
    expect((await app.request("/v1/consultations/pc_1/drive/link", post({ actor_user_id: "11111" }))).status).toBe(400);
    // The email address of the old flow is no longer accepted.
    expect((await app.request("/v1/consultations/pc_1/drive/link", post({ actor_user_id: "11111", folder: "1AbCdEfGhIjK", email: "me@example.com" }))).status).toBe(400);
    expect((await app.request("/v1/consultations/pc_1/drive/open", post({ actor_user_id: "11111", email: "me@example.com" }))).status).toBe(404);
    expect(link).not.toHaveBeenCalled();
  });
});
