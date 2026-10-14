/**
 * 相談のファイル受け渡し (Google Drive) の手順 (spec/feature/tech-consultation.md §6.4)。
 *
 * - guide: 相談者が自分の Drive のフォルダを共有する相手 (Cc のサービスアカウントのメールアドレス) を返す。 相談者本人だけ。
 * - link: 相談者が共有したフォルダ (URL か ID) に Cc が編集者として届くかを確かめ、 相談に結び付ける。 相談者本人だけ。
 *   フォルダは作らず、 共有もしない (共有の権限は相談者が Drive で持つ)。
 * - sync: 相談者のファイルを相談者のデータフォルダの transfer/incoming/ へ取り込み、 transfer/outgoing/ の回答を同じフォルダへ置く。
 *   相談者本人と権限者。
 *
 * 設定 (サービスアカウントの鍵) が無ければ drive_not_configured を返す (fail closed、 相談は止めない)。
 * 結び付けと状態は Drive のアプリのプロパティが持ち、 Cc の DB は増やさない (フォルダ ID 以外の個人情報を保存しない)。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { join } from "node:path";
import type { PrivateConsultationRow, PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import type { DriveTransferConfig } from "./drive-transfer-config.js";
import {
  classifyTransferFile,
  consultTransferDirs,
  decideDriveFolderLink,
  DRIVE_FOLDER_MIME,
  DRIVE_KIND_ANSWER,
  DRIVE_PROP_CONSULTATION,
  DRIVE_PROP_IMPORTED,
  DRIVE_PROP_KIND,
  DRIVE_PROP_SOURCE_NAME,
  DRIVE_TRANSFER_MAX_BYTES,
  parseDriveFolderId,
  type DriveFolderLinkRejection,
  type TransferFileKind,
  type TransferFileRejection,
} from "./drive-transfer-policy.js";
import { DriveTransferError, type DriveFolder, type DriveTransferPort } from "./drive-transfer-port.js";

export type DriveTransferErrorCode =
  | "consultation_not_found"
  | "not_requester"
  | "not_allowed"
  | "transfer_unavailable"
  | "drive_not_configured"
  | "invalid_folder"
  | "folder_unreachable"
  | DriveFolderLinkRejection
  | "folder_not_linked"
  | "drive_failed";

export type DriveTransferFailure = { ok: false; error: DriveTransferErrorCode; detail?: DriveTransferError["code"] };

export type SkipReason = TransferFileRejection | "already_exists";

export interface DriveSyncResult {
  ok: true;
  folder: DriveFolder;
  imported: Array<{ name: string; path: string; kind: TransferFileKind }>;
  delivered: Array<{ name: string; kind: TransferFileKind }>;
  skipped: Array<{ name: string; direction: "incoming" | "outgoing"; reason: SkipReason }>;
}

/** 相談者のデータフォルダのファイル操作 (テストで差し替える)。 */
export interface TransferFiles {
  /** フォルダ直下のファイル (無ければ空)。 */
  list(dir: string): Promise<Array<{ name: string; size: number }>>;
  read(path: string): Promise<Uint8Array>;
  /** 新しく書く。 既にあれば書かずに false (上書きしない)。 */
  writeNew(path: string, bytes: Uint8Array): Promise<boolean>;
}

export interface DriveTransferServiceDeps {
  consultations: Pick<PrivateConsultationsRepo, "find" | "members">;
  /** 復号済みの設定。 未設定・読めないときは null。 */
  config(): DriveTransferConfig | null;
  drive(config: DriveTransferConfig): DriveTransferPort;
  /** 相談者のデータフォルダ (相談の置き場所で動くセッションだけ)。 求まらなければ null。 */
  dataDir(consultation: PrivateConsultationRow): string | null;
  files: TransferFiles;
}

export class DriveTransferService {
  constructor(private readonly deps: DriveTransferServiceDeps) {}

  /** 共有の案内に使うサービスアカウントのメールアドレス (相談者本人だけ)。 */
  guide(input: { consultationId: string; actorUserId: string }): { ok: true; serviceAccountEmail: string } | DriveTransferFailure {
    const consultation = this.deps.consultations.find(input.consultationId);
    if (!consultation) return { ok: false, error: "consultation_not_found" };
    if (consultation.requester_user_id !== input.actorUserId) return { ok: false, error: "not_requester" };
    const config = this.deps.config();
    if (!config) return { ok: false, error: "drive_not_configured" };
    if (!this.deps.dataDir(consultation)) return { ok: false, error: "transfer_unavailable" };
    return { ok: true, serviceAccountEmail: config.serviceAccount.clientEmail };
  }

  /**
   * 相談者が共有したフォルダを相談に結び付ける。 届かない・フォルダでない・閲覧者のみ・他の相談者の相談に結び付いているなら
   * 理由を返して結び付けない。 同じ相談に前に結び付けたフォルダがあれば、 そちらの印を外して付け替える (フォルダ自体は消さない)。
   */
  async link(input: { consultationId: string; actorUserId: string; folder: string }): Promise<
    { ok: true; folder: DriveFolder; relinked: boolean } | DriveTransferFailure
  > {
    const consultation = this.deps.consultations.find(input.consultationId);
    if (!consultation) return { ok: false, error: "consultation_not_found" };
    if (consultation.requester_user_id !== input.actorUserId) return { ok: false, error: "not_requester" };
    const config = this.deps.config();
    if (!config) return { ok: false, error: "drive_not_configured" };
    if (!this.deps.dataDir(consultation)) return { ok: false, error: "transfer_unavailable" };
    const folderId = parseDriveFolderId(input.folder);
    if (!folderId) return { ok: false, error: "invalid_folder" };
    return this.guard(async () => {
      const drive = this.deps.drive(config);
      const info = await drive.getFolder(folderId);
      if (!info) return { ok: false as const, error: "folder_unreachable" as const };
      const decision = decideDriveFolderLink(
        { mimeType: info.mimeType, trashed: info.trashed, canAddChildren: info.canAddChildren, linkedConsultationId: info.appProperties[DRIVE_PROP_CONSULTATION] ?? null },
        { consultationId: consultation.id, requesterUserId: consultation.requester_user_id },
        (id) => this.deps.consultations.find(id)?.requester_user_id ?? null,
      );
      if (!decision.ok) return { ok: false as const, error: decision.reason };
      const previous = (await drive.findFolders({ key: DRIVE_PROP_CONSULTATION, value: consultation.id }))
        .filter((folder) => folder.id !== info.id);
      for (const folder of previous) await drive.setAppProperties(folder.id, { [DRIVE_PROP_CONSULTATION]: null });
      await drive.setAppProperties(info.id, { [DRIVE_PROP_CONSULTATION]: consultation.id });
      return { ok: true as const, folder: { id: info.id, url: info.url }, relinked: previous.length > 0 };
    });
  }

  async sync(input: { consultationId: string; actorUserId: string }): Promise<DriveSyncResult | DriveTransferFailure> {
    const consultation = this.deps.consultations.find(input.consultationId);
    if (!consultation) return { ok: false, error: "consultation_not_found" };
    const actor = this.deps.consultations.members(consultation.id)
      .find((member) => member.platform_user_id === input.actorUserId && member.removed_at === null);
    if (!actor || (actor.reason !== "requester" && actor.reason !== "approver")) return { ok: false, error: "not_allowed" };
    const config = this.deps.config();
    if (!config) return { ok: false, error: "drive_not_configured" };
    const dataDir = this.deps.dataDir(consultation);
    if (!dataDir) return { ok: false, error: "transfer_unavailable" };
    return this.guard(async () => {
      const drive = this.deps.drive(config);
      const [folder] = await drive.findFolders({ key: DRIVE_PROP_CONSULTATION, value: consultation.id });
      if (!folder) return { ok: false as const, error: "folder_not_linked" as const };
      const dirs = consultTransferDirs(dataDir);
      const result: DriveSyncResult = { ok: true, folder, imported: [], delivered: [], skipped: [] };
      const remote = await drive.listFiles(folder.id);
      for (const file of remote) {
        if (file.mimeType === DRIVE_FOLDER_MIME) continue;
        if (file.appProperties[DRIVE_PROP_KIND] === DRIVE_KIND_ANSWER) continue;
        if (file.appProperties[DRIVE_PROP_IMPORTED] === "1") continue;
        // 大きさを持たない Google ドキュメント等は種類の判定で落ちる。
        const decision = classifyTransferFile({ name: file.name, size: file.size ?? (file.mimeType.startsWith("application/vnd.google-apps.") ? 0 : null) });
        if (!decision.ok) {
          result.skipped.push({ name: file.name, direction: "incoming", reason: decision.reason });
          continue;
        }
        const bytes = await drive.download(file.id);
        if (bytes.byteLength > DRIVE_TRANSFER_MAX_BYTES) {
          result.skipped.push({ name: file.name, direction: "incoming", reason: "too_large" });
          continue;
        }
        const path = join(dirs.incoming, decision.fileName);
        if (!(await this.deps.files.writeNew(path, bytes))) {
          result.skipped.push({ name: decision.fileName, direction: "incoming", reason: "already_exists" });
          continue;
        }
        await drive.setAppProperties(file.id, { [DRIVE_PROP_IMPORTED]: "1" });
        result.imported.push({ name: decision.fileName, path, kind: decision.kind });
      }
      const delivered = new Set(remote
        .filter((file) => file.appProperties[DRIVE_PROP_KIND] === DRIVE_KIND_ANSWER)
        .map((file) => file.appProperties[DRIVE_PROP_SOURCE_NAME] ?? file.name));
      for (const local of await this.deps.files.list(dirs.outgoing)) {
        if (delivered.has(local.name)) continue;
        const decision = classifyTransferFile({ name: local.name, size: local.size });
        if (!decision.ok || decision.fileName !== local.name) {
          result.skipped.push({ name: local.name, direction: "outgoing", reason: decision.ok ? "invalid_name" : decision.reason });
          continue;
        }
        const bytes = await this.deps.files.read(join(dirs.outgoing, local.name));
        await drive.upload(folder.id, {
          name: local.name,
          bytes,
          appProperties: { [DRIVE_PROP_KIND]: DRIVE_KIND_ANSWER, [DRIVE_PROP_SOURCE_NAME]: local.name },
        });
        result.delivered.push({ name: local.name, kind: decision.kind });
      }
      return result;
    });
  }

  private async guard<T>(run: () => Promise<T>): Promise<T | DriveTransferFailure> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof DriveTransferError) return { ok: false, error: "drive_failed", detail: error.code };
      throw error;
    }
  }
}
