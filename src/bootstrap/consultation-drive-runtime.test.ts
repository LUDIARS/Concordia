import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrivateConsultationRow } from "../db/private-consultations-repo.js";
import { createConsultationDrive, DRIVE_PARENT_FOLDER_SETTING, DRIVE_SERVICE_ACCOUNT_SETTING } from "./consultation-drive-runtime.js";

const ROOT = join("E:", "Document", "Consult");
/** A key generated per run, so no key material is committed with the fixture. */
const throwawayPrivateKey = (): string =>
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const consultation = { id: "pc_1", requester_user_id: "11111", session_id: "sess-1", status: "open" } as PrivateConsultationRow;
const requester = [{ consultation_id: "pc_1", platform_user_id: "11111", reason: "requester" as const, added_by: "11111", added_at: 0, removed_at: null }];

function runtime(options: { settings?: Record<string, string>; repoPath?: string | null }) {
  const readSetting = vi.fn((key: string) => options.settings?.[key] ?? null);
  const drive = createConsultationDrive({
    consultations: { find: () => consultation, members: () => requester },
    readSetting,
    findSession: () => (options.repoPath === undefined ? { repo_path: join(ROOT, "designer") } : { repo_path: options.repoPath }),
    workspaceRoot: ROOT,
  });
  return { drive, readSetting };
}

describe("createConsultationDrive", () => {
  it("reads the key and the parent folder from the settings screen values on each call and fails closed without them", async () => {
    const { drive, readSetting } = runtime({ settings: {} });
    expect(await drive.sync({ consultationId: "pc_1", actorUserId: "11111" })).toEqual({ ok: false, error: "drive_not_configured" });
    expect(readSetting).toHaveBeenCalledWith(DRIVE_SERVICE_ACCOUNT_SETTING);
    expect(readSetting).toHaveBeenCalledWith(DRIVE_PARENT_FOLDER_SETTING);
  });

  it("refuses sessions that do not run in the consult workspace", async () => {
    const settings = {
      [DRIVE_SERVICE_ACCOUNT_SETTING]: JSON.stringify({ type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: throwawayPrivateKey() }),
      [DRIVE_PARENT_FOLDER_SETTING]: "parent123456",
    };
    const { drive } = runtime({ settings, repoPath: join("E:", "Document", "Ars", "Concordia") });
    expect(await drive.sync({ consultationId: "pc_1", actorUserId: "11111" })).toEqual({ ok: false, error: "transfer_unavailable" });
  });
});
