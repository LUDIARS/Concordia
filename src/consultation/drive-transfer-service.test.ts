import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrivateConsultationMemberRow, PrivateConsultationRow } from "../db/private-consultations-repo.js";
import type { DriveTransferConfig } from "./drive-transfer-config.js";
import { DriveTransferError, type DriveFile, type DriveTransferPort } from "./drive-transfer-port.js";
import { DriveTransferService, type TransferFiles } from "./drive-transfer-service.js";

const DATA_DIR = join("C:", "Consult", "designer", "11111");
const INCOMING = join(DATA_DIR, "transfer", "incoming");
const OUTGOING = join(DATA_DIR, "transfer", "outgoing");
const CONFIG = { parentFolderId: "parent123456", serviceAccount: { clientEmail: "a@b.c", privateKey: "k", tokenUri: "u" } } as DriveTransferConfig;

const consultation = {
  id: "pc_abcdef123456", requester_user_id: "11111", session_id: "sess-1", status: "open",
} as PrivateConsultationRow;

const members: PrivateConsultationMemberRow[] = [
  { consultation_id: consultation.id, platform_user_id: "11111", reason: "requester", added_by: "11111", added_at: 0, removed_at: null },
  { consultation_id: consultation.id, platform_user_id: "22222", reason: "approver", added_by: "11111", added_at: 0, removed_at: null },
  { consultation_id: consultation.id, platform_user_id: "33333", reason: "invited", added_by: "11111", added_at: 0, removed_at: null },
  { consultation_id: consultation.id, platform_user_id: "44444", reason: "approver", added_by: "11111", added_at: 0, removed_at: 5 },
];

function fakeDrive(remote: DriveFile[] = [], options: { folder?: boolean } = {}) {
  const port: DriveTransferPort = {
    findFolder: vi.fn(async () => (options.folder === false ? null : { id: "folder1", url: "https://drive/folder1" })),
    createFolder: vi.fn(async () => ({ id: "folder-new", url: "https://drive/folder-new" })),
    share: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => remote),
    download: vi.fn(async () => new Uint8Array([7, 7])),
    setAppProperties: vi.fn(async () => undefined),
    upload: vi.fn(async () => ({ id: "up" })),
  };
  return port;
}

function fakeFiles(outgoing: Array<{ name: string; size: number }> = [], existing: string[] = []) {
  const written = new Map<string, Uint8Array>();
  const files: TransferFiles = {
    list: vi.fn(async (dir: string) => (dir === OUTGOING ? outgoing : [])),
    read: vi.fn(async () => new Uint8Array([9])),
    writeNew: vi.fn(async (path: string, bytes: Uint8Array) => {
      if (existing.includes(path) || written.has(path)) return false;
      written.set(path, bytes);
      return true;
    }),
  };
  return { files, written };
}

function makeService(options: {
  drive?: DriveTransferPort;
  files?: TransferFiles;
  config?: DriveTransferConfig | null;
  dataDir?: string | null;
} = {}) {
  const drive = options.drive ?? fakeDrive();
  const service = new DriveTransferService({
    consultations: {
      find: (id) => (id === consultation.id ? consultation : null),
      members: () => members,
    },
    config: () => (options.config === undefined ? CONFIG : options.config),
    drive: () => drive,
    dataDir: () => (options.dataDir === undefined ? DATA_DIR : options.dataDir),
    files: options.files ?? fakeFiles().files,
    now: () => new Date("2026-10-14T00:00:00Z"),
  });
  return { service, drive };
}

const remoteFile = (overrides: Partial<DriveFile>): DriveFile => ({
  id: "r1", name: "chara.fbx", mimeType: "application/octet-stream", size: 100, appProperties: {}, ...overrides,
});

describe("DriveTransferService.open", () => {
  it("creates the consultation folder with its id as an app property and shares it to the requester", async () => {
    const drive = fakeDrive([], { folder: false });
    const { service } = makeService({ drive });
    const result = await service.open({ consultationId: consultation.id, actorUserId: "11111", email: "me@example.com" });
    expect(result).toEqual({ ok: true, folder: { id: "folder-new", url: "https://drive/folder-new" }, created: true });
    expect(drive.createFolder).toHaveBeenCalledWith("parent123456", "相談-20261014-abcdef", { ccConsultationId: consultation.id });
    expect(drive.share).toHaveBeenCalledWith("folder-new", { type: "user", role: "writer", emailAddress: "me@example.com" });
  });

  it("reuses an existing folder", async () => {
    const { service, drive } = makeService();
    const result = await service.open({ consultationId: consultation.id, actorUserId: "11111", email: "me@example.com" });
    expect(result).toMatchObject({ ok: true, created: false });
    expect(drive.createFolder).not.toHaveBeenCalled();
  });

  it("is only for the requester and fails closed without configuration", async () => {
    expect(await makeService().service.open({ consultationId: consultation.id, actorUserId: "22222", email: "x@example.com" }))
      .toEqual({ ok: false, error: "not_requester" });
    const unconfigured = makeService({ config: null });
    expect(await unconfigured.service.open({ consultationId: consultation.id, actorUserId: "11111", email: "x@example.com" }))
      .toEqual({ ok: false, error: "drive_not_configured" });
    expect(unconfigured.drive.findFolder).not.toHaveBeenCalled();
  });

  it("refuses consultations without a data folder and bad addresses", async () => {
    expect(await makeService({ dataDir: null }).service.open({ consultationId: consultation.id, actorUserId: "11111", email: "x@example.com" }))
      .toEqual({ ok: false, error: "transfer_unavailable" });
    expect(await makeService().service.open({ consultationId: consultation.id, actorUserId: "11111", email: "nope" }))
      .toEqual({ ok: false, error: "invalid_email" });
  });

  it("returns drive_failed with the code when Drive refuses", async () => {
    const drive = fakeDrive();
    vi.mocked(drive.share).mockRejectedValueOnce(new DriveTransferError("unauthorized", 403));
    const { service } = makeService({ drive });
    expect(await service.open({ consultationId: consultation.id, actorUserId: "11111", email: "me@example.com" }))
      .toEqual({ ok: false, error: "drive_failed", detail: "unauthorized" });
  });
});

describe("DriveTransferService.sync", () => {
  it("imports new requester files into the incoming folder and marks them imported on Drive", async () => {
    const drive = fakeDrive([
      remoteFile({ id: "m", name: "chara.fbx" }),
      remoteFile({ id: "done", name: "old.wav", appProperties: { ccImported: "1" } }),
      remoteFile({ id: "ans", name: "fixed.glb", appProperties: { ccKind: "answer", ccSourceName: "fixed.glb" } }),
      remoteFile({ id: "dir", name: "sub", mimeType: "application/vnd.google-apps.folder", size: null }),
      remoteFile({ id: "doc", name: "memo", mimeType: "application/vnd.google-apps.document", size: null }),
      remoteFile({ id: "txt", name: "readme.txt" }),
    ]);
    const { files, written } = fakeFiles();
    const { service } = makeService({ drive, files });
    const result = await service.sync({ consultationId: consultation.id, actorUserId: "11111" });
    expect(result).toEqual({
      ok: true,
      folder: { id: "folder1", url: "https://drive/folder1" },
      imported: [{ name: "chara.fbx", path: join(INCOMING, "chara.fbx"), kind: "model" }],
      delivered: [],
      skipped: [
        { name: "memo", direction: "incoming", reason: "unsupported_type" },
        { name: "readme.txt", direction: "incoming", reason: "unsupported_type" },
      ],
    });
    expect([...written.keys()]).toEqual([join(INCOMING, "chara.fbx")]);
    expect(drive.download).toHaveBeenCalledTimes(1);
    expect(drive.setAppProperties).toHaveBeenCalledWith("m", { ccImported: "1" });
  });

  it("does not overwrite a file of the same name and leaves it unmarked", async () => {
    const drive = fakeDrive([remoteFile({ id: "m", name: "chara.fbx" })]);
    const { files } = fakeFiles([], [join(INCOMING, "chara.fbx")]);
    const { service } = makeService({ drive, files });
    const result = await service.sync({ consultationId: consultation.id, actorUserId: "11111" });
    expect(result).toMatchObject({ ok: true, imported: [], skipped: [{ name: "chara.fbx", direction: "incoming", reason: "already_exists" }] });
    expect(drive.setAppProperties).not.toHaveBeenCalled();
  });

  it("uploads new answer files once, tagged as answers", async () => {
    const drive = fakeDrive([remoteFile({ id: "ans", name: "fixed.glb", appProperties: { ccKind: "answer", ccSourceName: "fixed.glb" } })]);
    const { files } = fakeFiles([{ name: "fixed.glb", size: 10 }, { name: "mix.wav", size: 10 }, { name: "notes.md", size: 1 }]);
    const { service } = makeService({ drive, files });
    const result = await service.sync({ consultationId: consultation.id, actorUserId: "22222" });
    expect(result).toMatchObject({
      ok: true,
      delivered: [{ name: "mix.wav", kind: "audio" }],
      skipped: [{ name: "notes.md", direction: "outgoing", reason: "unsupported_type" }],
    });
    expect(drive.upload).toHaveBeenCalledTimes(1);
    expect(drive.upload).toHaveBeenCalledWith("folder1", {
      name: "mix.wav", bytes: new Uint8Array([9]), appProperties: { ccKind: "answer", ccSourceName: "mix.wav" },
    });
    expect(files.read).toHaveBeenCalledWith(join(OUTGOING, "mix.wav"));
  });

  it("is for the requester and active approvers only", async () => {
    const { service } = makeService();
    expect(await service.sync({ consultationId: consultation.id, actorUserId: "33333" })).toEqual({ ok: false, error: "not_allowed" });
    expect(await service.sync({ consultationId: consultation.id, actorUserId: "44444" })).toEqual({ ok: false, error: "not_allowed" });
    expect(await service.sync({ consultationId: "pc_none", actorUserId: "11111" })).toEqual({ ok: false, error: "consultation_not_found" });
  });

  it("needs the folder to be opened first and the configuration to be set", async () => {
    expect(await makeService({ drive: fakeDrive([], { folder: false }) }).service.sync({ consultationId: consultation.id, actorUserId: "11111" }))
      .toEqual({ ok: false, error: "folder_not_opened" });
    expect(await makeService({ config: null }).service.sync({ consultationId: consultation.id, actorUserId: "11111" }))
      .toEqual({ ok: false, error: "drive_not_configured" });
  });

  it("skips downloads that turn out larger than the limit", async () => {
    const drive = fakeDrive([remoteFile({ id: "m", name: "huge.wav", size: null })]);
    vi.mocked(drive.download).mockResolvedValueOnce({ byteLength: 200 * 1024 * 1024 + 1 } as Uint8Array);
    const { service } = makeService({ drive });
    expect(await service.sync({ consultationId: consultation.id, actorUserId: "11111" }))
      .toMatchObject({ ok: true, imported: [], skipped: [{ name: "huge.wav", direction: "incoming", reason: "too_large" }] });
  });
});
