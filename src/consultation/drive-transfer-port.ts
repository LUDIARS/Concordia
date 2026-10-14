/**
 * 相談のファイル受け渡しが使う Google Drive のポート (spec/feature/tech-consultation.md §6.4)。
 * 実装は google-drive-client.ts。 テストはこのポートのモックで行う (実際の Drive には繋がない)。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

export interface DriveFolder {
  id: string;
  url: string;
}

/** 相談者が共有したフォルダを、 サービスアカウントから見た姿。 */
export interface DriveFolderInfo extends DriveFolder {
  mimeType: string;
  trashed: boolean;
  /** フォルダに中身を足せるか (capabilities.canAddChildren)。 閲覧者・閲覧者 (コメント可) では false。 */
  canAddChildren: boolean;
  appProperties: Readonly<Record<string, string>>;
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
  /** サービスアカウントから届くファイル・フォルダ。 届かない (共有されていない・無い) ときは null。 */
  getFolder(folderId: string): Promise<DriveFolderInfo | null>;
  /** アプリのプロパティが一致するフォルダ (サービスアカウントから届くもの、 ゴミ箱を除く)。 */
  findFolders(property: { key: string; value: string }): Promise<DriveFolder[]>;
  /** フォルダ直下のファイル (ゴミ箱を除く)。 */
  listFiles(folderId: string): Promise<DriveFile[]>;
  download(fileId: string): Promise<Uint8Array>;
  /** アプリのプロパティを足す・書き換える。 値が null の鍵は外す。 */
  setAppProperties(fileId: string, appProperties: Readonly<Record<string, string | null>>): Promise<void>;
  upload(folderId: string, input: { name: string; bytes: Uint8Array; appProperties: Readonly<Record<string, string>> }): Promise<{ id: string }>;
}
