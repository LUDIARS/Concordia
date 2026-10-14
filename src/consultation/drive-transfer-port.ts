/**
 * 相談のファイル受け渡しが使う Google Drive のポート (spec/feature/tech-consultation.md §6.4)。
 * 実装は google-drive-client.ts。 テストはこのポートのモックで行う (実際の Drive には繋がない)。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import type { DriveFolderPermission } from "./drive-transfer-policy.js";

export interface DriveFolder {
  id: string;
  url: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** バイト数。 Google ドキュメント等の大きさを持たないものは null。 */
  size: number | null;
  appProperties: Readonly<Record<string, string>>;
}

export class DriveTransferError extends Error {
  constructor(readonly code: "unauthorized" | "unreachable" | "rejected" | "malformed_response", readonly status: number | null) {
    // 応答本文・トークンは載せない (ログへ流さない)。
    super(`google drive failed: ${code}${status === null ? "" : ` (${status})`}`);
    this.name = "DriveTransferError";
  }
}

export interface DriveTransferPort {
  /** 親フォルダの中で、 アプリのプロパティが一致するフォルダ (ゴミ箱を除く)。 */
  findFolder(parentId: string, property: { key: string; value: string }): Promise<DriveFolder | null>;
  createFolder(parentId: string, name: string, appProperties: Readonly<Record<string, string>>): Promise<DriveFolder>;
  /** 共有を足す (招待メールは Google が送る)。 */
  share(folderId: string, permission: DriveFolderPermission): Promise<void>;
  /** フォルダ直下のファイル (ゴミ箱を除く)。 */
  listFiles(folderId: string): Promise<DriveFile[]>;
  download(fileId: string): Promise<Uint8Array>;
  setAppProperties(fileId: string, appProperties: Readonly<Record<string, string>>): Promise<void>;
  upload(folderId: string, input: { name: string; bytes: Uint8Array; appProperties: Readonly<Record<string, string>> }): Promise<{ id: string }>;
}
