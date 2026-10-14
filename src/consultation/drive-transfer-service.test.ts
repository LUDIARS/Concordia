import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrivateConsultationMemberRow, PrivateConsultationRow } from "../db/private-consultations-repo.js";
import type { DriveTransferConfig } from "./drive-transfer-config.js";
import { DriveTransferError, type DriveFile, type DriveFolderInfo, type DriveTransferPort } from "./drive-transfer-port.js";
import { DriveTransferService, type TransferFiles } from "./drive-transfer-service.js";

const DATA_DIR = join("C:", "Consult", "designer", "11111");
const INCOMING = join(DATA_DIR, "transfer", "incoming");
const OUTGOING = join(DATA_DIR, "transfer", "outgoing");
const CONFIG = { serviceAccount: { clientEmail: "cc@project.iam.gserviceaccount.com", privateKey: "k", tokenUri: "u" } } as DriveTransferConfig;
const FOLDER_ID = "1AbCdEfGhIjKlMnOp";
const FOLDER_URL = `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`;

const consultation = {
  id: "pc_abcdef123456", requester_user_id: "11111", session_id: "sess-1", status: "open",
} as PrivateConsultationRow;

const members: PrivateConsultationMemberRow[] = [
  { consultation_id: consultation.id, platform_user_id: "11111", reason: "requester", added_by: "11111", added_at: 0, removed_at: null },
  { consultation_id: consultation.id, platform_user_id: "22222", reason: "approver", added_by: "11111", added_at: 0, removed_at: null },
  { consultation_id: consultation.id, platform_user_id: "33333", reason: "invited", added_by: "11111", added_at: 0, removed_at: null },
  { consultation_id: consultation.id, platform_user_id: "44444", reason: "approver", added_by: "11111", added_at: 0, removed_at: 5 },
];

function sharedFolder(overrides: Partial<DriveFolderInfo> = {}): DriveFolderInfo {
  return {
    id: FOLDER_ID, url: "https://drive/shared", mimeType: "application/vnd.google-apps.folder",
    trashed: false, canAddChildren: true, appProperties: {}, ...overrides,
  };
}

function fakeDrive(remote: DriveFile[] = [], options: { folder?: boolean; shared?: DriveFolderInfo | null; linked?: Array<{ id: string; url: string }> } = {}) {
  const port: DriveTransferPort = {
    getFolder: vi.fn(async () => (options.shared === undefined ? sharedFolder() : options.shared)),
    findFolders: vi.fn(async () => options.linked ?? (options.folder === false ? [] : [{ id: "folder1", url: "https://drive/folder1" }])),
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
      find: (id) => (id === consultation.id ? consultation : id === "pc_other" ? ({ ...consultation, id, requester_user_id: "99999" }) : null),
      members: () => members,
    },
    config: () => (options.config === undefined ? CONFIG : options.config),
    drive: () => drive,
    dataDir: () => (options.dataDir === undefined ? DATA_DIR : options.dataDir),
    files: options.files ?? fakeFiles().files,
  });
  return { service, drive };
}

const remoteFile = (overrides: Partial<DriveFile>): DriveFile => ({
  id: "r1", name: "chara.fbx", mimeType: "application/octet-stream", size: 100, appProperties: {}, ...overrides,
});

describe("DriveTransferService.guide", () => {
  it("tells the requester which address to share their folder with", () => {
    expect(makeService().service.guide({ consultationId: consultation.id, actorUserId: "11111" }))
      .toEqual({ ok: true, serviceAccountEmail: "cc@project.iam.gserviceaccount.com" });
  });

  it("is only for the requester and says unconfigured without the key", () => {
    expect(makeService().service.guide({ consultationId: consultation.id, actorUserId: "22222" })).toEqual({ ok: false, error: "not_requester" });
    expect(makeService({ config: null }).service.guide({ consultationId: consultation.id, actorUserId: "11111" }))
      .toEqual({ ok: false, error: "drive_not_configured" });
    expect(makeService({ dataDir: null }).service.guide({ consultationId: consultation.id, actorUserId: "11111" }))
      .toEqual({ ok: false, error: "transfer_unavailable" });
  });
});

describe("DriveTransferService.link", () => {
  it("checks the shared folder and links it with the consultation id as an app property, without creating or sharing", async () => {
    const drive = fakeDrive([], { linked: [] });
    const { service } = makeService({ drive });
    const result = await service.link({ consultationId: consultation.id, actorUserId: "11111", folder: FOLDER_URL });
    expect(result).toEqual({ ok: true, folder: { id: FOLDER_ID, url: "https://drive/shared" }, relinked: false });
    expect(drive.getFolder).toHaveBeenCalledWith(FOLDER_ID);
    expect(drive.setAppProperties).toHaveBeenCalledTimes(1);
    expect(drive.setAppProperties).toHaveBeenCalledWith(FOLDER_ID, { ccConsultationId: consultation.id });
  });

  it("moves the link off a folder linked earlier to the same consultation (the folder itself is kept)", async () => {
    const drive = fakeDrive([], { linked: [{ id: "old-folder", url: "https://drive/old" }, { id: FOLDER_ID, url: "https://drive/shared" }] });
    const { service } = makeService({ drive });
    expect(await service.link({ consultationId: consultation.id, actorUserId: "11111", folder: FOLDER_ID }))
      .toMatchObject({ ok: true, relinked: true });
    expect(drive.setAppProperties).toHaveBeenCalledWith("old-folder", { ccConsultationId: null });
    expect(drive.setAppProperties).toHaveBeenLastCalledWith(FOLDER_ID, { ccConsultationId: consultation.id });
  });

  it("does not link a folder Cc cannot reach, a viewer-only share or another requester's folder", async () => {
    const unreachable = makeService({ drive: fakeDrive([], { shared: null }) });
    expect(await unreachable.service.link({ consultationId: consultation.id, actorUserId: "11111", folder: FOLDER_ID }))
      .toEqual({ ok: false, error: "folder_unreachable" });
    const viewer = makeService({ drive: fakeDrive([], { shared: sharedFolder({ canAddChildren: false }) }) });
    expect(await viewer.service.link({ consultationId: consultation.id, actorUserId: "11111", folder: FOLDER_ID }))
      .toEqual({ ok: false, error: "folder_read_only" });
    expect(viewer.drive.setAppProperties).not.toHaveBeenCalled();
    const taken = makeService({ drive: fakeDrive([], { shared: sharedFolder({ appProperties: { ccConsultationId: "pc_other" } }) }) });
    expect(await taken.service.link({ consultationId: consultation.id, actorUserId: "11111", folder: FOLDER_ID }))
      .toEqual({ ok: false, error: "folder_linked_elsewhere" });
    expect(taken.drive.setAppProperties).not.toHaveBeenCalled();
  });

  it("is only for the requester, needs a readable folder reference and fails closed without the key", async () => {
    expect(await makeService().service.link({ consultationId: consultation.id, actorUserId: "22222", folder: FOLDER_ID }))
      .toEqual({ ok: false, error: "not_requester" });
    const bad = makeService();
    expect(await bad.service.link({ consultationId: consultation.id, actorUserId: "11111", folder: "https://example.com/x" }))
      .toEqual({ ok: false, error: "invalid_folder" });
    expect(bad.drive.getFolder).not.toHaveBeenCalled();
    const unconfigured = makeService({ config: null });
    expect(await unconfigured.service.link({ consultationId: consultation.id, actorUserId: "11111", folder: FOLDER_ID }))
      .toEqual({ ok: false, error: "drive_not_configured" });
    expect(unconfigured.drive.getFolder).not.toHaveBeenCalled();
  });

  it("returns drive_failed with the code when Drive refuses", async () => {
    const drive = fakeDrive([], { linked: [] });
    vi.mocked(drive.setAppProperties).mockRejectedValueOnce(new DriveTransferError("unauthorized", 403));
    const { service } = makeService({ drive });
    expect(await service.link({ consultationId: consultation.id, actorUserId: "11111", folder: FOLDER_ID }))
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

  it("needs a linked folder and the configuration to be set", async () => {
    expect(await makeService({ drive: fakeDrive([], { folder: false }) }).service.sync({ consultationId: consultation.id, actorUserId: "11111" }))
      .toEqual({ ok: false, error: "folder_not_linked" });
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
