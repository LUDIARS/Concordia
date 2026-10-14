import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyTransferFile,
  consultTransferDirs,
  decideDriveFolderLink,
  DRIVE_TRANSFER_MAX_BYTES,
  parseDriveFolderId,
  sanitizeTransferFileName,
  type DriveFolderAccess,
} from "./drive-transfer-policy.js";

describe("classifyTransferFile", () => {
  it("accepts 3D models and audio within the size limit", () => {
    expect(classifyTransferFile({ name: "chara.FBX", size: 1024 })).toEqual({ ok: true, kind: "model", fileName: "chara.FBX" });
    expect(classifyTransferFile({ name: "se_hit.wav", size: null })).toEqual({ ok: true, kind: "audio", fileName: "se_hit.wav" });
    expect(classifyTransferFile({ name: "bgm.ogg", size: DRIVE_TRANSFER_MAX_BYTES })).toMatchObject({ ok: true, kind: "audio" });
  });

  it("rejects other types, oversized files and unusable names", () => {
    expect(classifyTransferFile({ name: "notes.txt", size: 10 })).toEqual({ ok: false, reason: "unsupported_type" });
    expect(classifyTransferFile({ name: "run.exe", size: 10 })).toEqual({ ok: false, reason: "unsupported_type" });
    expect(classifyTransferFile({ name: "big.wav", size: DRIVE_TRANSFER_MAX_BYTES + 1 })).toEqual({ ok: false, reason: "too_large" });
    expect(classifyTransferFile({ name: "..", size: 1 })).toEqual({ ok: false, reason: "invalid_name" });
    expect(classifyTransferFile({ name: ".glb", size: 1 })).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("keeps only the file name part so a name cannot climb out of the transfer folder", () => {
    expect(classifyTransferFile({ name: "../../secret/model.glb", size: 1 })).toEqual({ ok: true, kind: "model", fileName: "model.glb" });
    expect(classifyTransferFile({ name: "..\\..\\x.mp3", size: 1 })).toEqual({ ok: true, kind: "audio", fileName: "x.mp3" });
  });
});

describe("sanitizeTransferFileName", () => {
  it("drops characters Windows cannot store and refuses reserved names", () => {
    expect(sanitizeTransferFileName("a<b>:c?.wav")).toBe("abc.wav");
    expect(sanitizeTransferFileName("con.wav")).toBeNull();
    expect(sanitizeTransferFileName("   ")).toBeNull();
  });
});

describe("parseDriveFolderId", () => {
  const ID = "1AbCdEfGhIjKlMnOpQ_rs-TuV";

  it("reads a bare id and the folder URLs Drive shows", () => {
    expect(parseDriveFolderId(` ${ID} `)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/drive/folders/${ID}`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/drive/u/1/folders/${ID}/`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
  });

  it("refuses other hosts, file links, plain http and unusable ids", () => {
    expect(parseDriveFolderId(`https://evil.example/drive/folders/${ID}`)).toBeNull();
    expect(parseDriveFolderId(`http://drive.google.com/drive/folders/${ID}`)).toBeNull();
    expect(parseDriveFolderId(`https://drive.google.com/file/d/${ID}/view`)).toBeNull();
    expect(parseDriveFolderId("short")).toBeNull();
    expect(parseDriveFolderId("../../etc/passwd-folder")).toBeNull();
  });
});

describe("decideDriveFolderLink", () => {
  const folder = (overrides: Partial<DriveFolderAccess> = {}): DriveFolderAccess => ({
    mimeType: "application/vnd.google-apps.folder", trashed: false, canAddChildren: true, linkedConsultationId: null, ...overrides,
  });
  const target = { consultationId: "pc_1", requesterUserId: "11111" };
  const requesterOf = (id: string) => ({ pc_1: "11111", pc_2: "11111", pc_9: "99999" } as Record<string, string>)[id] ?? null;

  it("links a folder the service account can edit", () => {
    expect(decideDriveFolderLink(folder(), target, requesterOf)).toEqual({ ok: true });
    expect(decideDriveFolderLink(folder({ linkedConsultationId: "pc_1" }), target, requesterOf)).toEqual({ ok: true });
    // The same requester may move their folder from an earlier consultation.
    expect(decideDriveFolderLink(folder({ linkedConsultationId: "pc_2" }), target, requesterOf)).toEqual({ ok: true });
  });

  it("refuses files, trashed folders, viewer-only shares and another requester's folder", () => {
    expect(decideDriveFolderLink(folder({ mimeType: "model/gltf-binary" }), target, requesterOf)).toEqual({ ok: false, reason: "not_a_folder" });
    expect(decideDriveFolderLink(folder({ trashed: true }), target, requesterOf)).toEqual({ ok: false, reason: "not_a_folder" });
    expect(decideDriveFolderLink(folder({ canAddChildren: false }), target, requesterOf)).toEqual({ ok: false, reason: "folder_read_only" });
    expect(decideDriveFolderLink(folder({ linkedConsultationId: "pc_9" }), target, requesterOf)).toEqual({ ok: false, reason: "folder_linked_elsewhere" });
    expect(decideDriveFolderLink(folder({ linkedConsultationId: "pc_gone" }), target, requesterOf)).toEqual({ ok: false, reason: "folder_linked_elsewhere" });
  });
});

describe("transfer dirs", () => {
  it("places incoming and outgoing under the requester's data folder", () => {
    expect(consultTransferDirs(join("C:", "Consult", "designer", "12345"))).toEqual({
      incoming: join("C:", "Consult", "designer", "12345", "transfer", "incoming"),
      outgoing: join("C:", "Consult", "designer", "12345", "transfer", "outgoing"),
    });
  });
});
