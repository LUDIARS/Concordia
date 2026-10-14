/**
 * 相談のファイル受け渡し (spec/feature/tech-consultation.md §6.4) の組み立て。
 *
 * 設定 (サービスアカウントの鍵) は呼ぶたびに設定画面の値 (schema_meta、 復号済み) から読む。 鍵ごとにアクセストークンを
 * 使い回す。 相談者のデータフォルダは、 セッションの作業フォルダが相談の置き場所の中にあるときだけ求める。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import type { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import { readDriveTransferConfig, type ServiceAccountKey } from "../consultation/drive-transfer-config.js";
import { DriveTransferService } from "../consultation/drive-transfer-service.js";
import { createGoogleDriveClient } from "../consultation/google-drive-client.js";
import { createServiceAccountTokenSource, type AccessTokenSource } from "../consultation/google-service-account-token.js";
import { consultPersonalDataDir, isInConsultWorkspace } from "../consultation/projectless-consult.js";
import { nodeTransferFiles } from "../consultation/transfer-files-node.js";

export const DRIVE_SERVICE_ACCOUNT_SETTING = "services.google_drive_service_account";

export interface ConsultationDriveRuntimeDeps {
  consultations: Pick<PrivateConsultationsRepo, "find" | "members">;
  /** 設定画面の値 (復号できなければ null)。 */
  readSetting(key: string): string | null;
  findSession(id: string): { repo_path: string | null } | null;
  workspaceRoot: string | null;
}

export function createConsultationDrive(deps: ConsultationDriveRuntimeDeps): DriveTransferService {
  let tokens: { key: ServiceAccountKey; source: AccessTokenSource } | null = null;
  const tokenSource = (key: ServiceAccountKey): AccessTokenSource => {
    if (!tokens || tokens.key.clientEmail !== key.clientEmail || tokens.key.privateKey !== key.privateKey) {
      tokens = { key, source: createServiceAccountTokenSource(key) };
    }
    return tokens.source;
  };
  return new DriveTransferService({
    consultations: deps.consultations,
    config: () => readDriveTransferConfig({ serviceAccountJson: deps.readSetting(DRIVE_SERVICE_ACCOUNT_SETTING) }),
    drive: (config) => createGoogleDriveClient(tokenSource(config.serviceAccount)),
    dataDir: (consultation) => {
      const session = consultation.session_id ? deps.findSession(consultation.session_id) : null;
      const cwd = session?.repo_path ?? null;
      if (!cwd || !isInConsultWorkspace(cwd, deps.workspaceRoot)) return null;
      return consultPersonalDataDir(cwd, consultation.requester_user_id);
    },
    files: nodeTransferFiles(),
  });
}
