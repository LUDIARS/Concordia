import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyTransferFile,
  consultDriveFolderName,
  consultTransferDirs,
  driveFolderPermission,
  DRIVE_TRANSFER_MAX_BYTES,
  sanitizeTransferFileName,
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

describe("driveFolderPermission", () => {
  it("shares to one user as a writer and never as a link", () => {
    expect(driveFolderPermission(" someone@example.com ")).toEqual({ type: "user", role: "writer", emailAddress: "someone@example.com" });
  });

  it("refuses something that is not an email address", () => {
    expect(driveFolderPermission("anyone")).toBeNull();
    expect(driveFolderPermission("a b@example.com")).toBeNull();
    expect(driveFolderPermission("x@localhost")).toBeNull();
  });
});

describe("folder name and transfer dirs", () => {
  it("names the folder without the consultation content", () => {
    expect(consultDriveFolderName(new Date("2026-10-14T01:00:00Z"), "pc_abcdef123456")).toBe("相談-20261014-abcdef");
  });

  it("places incoming and outgoing under the requester's data folder", () => {
    expect(consultTransferDirs(join("C:", "Consult", "designer", "12345"))).toEqual({
      incoming: join("C:", "Consult", "designer", "12345", "transfer", "incoming"),
      outgoing: join("C:", "Consult", "designer", "12345", "transfer", "outgoing"),
    });
  });
});
