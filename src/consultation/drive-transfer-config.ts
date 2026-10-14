import { contract } from './ontime-runtime.js'; /* augur-inject:import:920877c3 */
import augurContract_5fc229f0 from './drive-transfer-config.contract.js'; /* augur-inject:contract-predicate:83a3aaa4 */
/**
 * 相談のファイル受け渡しの設定 (spec/feature/tech-consultation.md §6.4)。
 *
 * サービスアカウントの鍵 (JSON) は Cc の設定画面 (schema_meta、 secret-box で暗号化) から復号済みで渡される。
 * 無い・読めないときは null (受け渡しを使わない、 fail closed)。 env からは読まない。 フォルダは相談者が自分の Drive に用意して
 * サービスアカウントに共有するので、 Cc 側に親フォルダの設定は持たない。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface DriveTransferConfig {
  serviceAccount: ServiceAccountKey;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export function readDriveTransferConfig(input: { serviceAccountJson: string | null }): DriveTransferConfig | null {
  const serviceAccount = parseServiceAccountKey(input.serviceAccountJson);
  return serviceAccount ? { serviceAccount } : null;
}
// @ts-expect-error augur-inject
readDriveTransferConfig = contract(readDriveTransferConfig, { ...augurContract_5fc229f0, contractId: 'consult-drive-C-3', mode: 'observe', sample: 1, where: 'src/consultation/drive-transfer-config.ts:22', rule: 'contract-wrap', id: '5fc229f0' }); /* augur-inject:contract-wrap:5fc229f0 */

/** Google Cloud のサービスアカウント鍵 (type=service_account) から署名に要る項目だけを取り出す。 */
export function parseServiceAccountKey(json: string | null): ServiceAccountKey | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.type !== "service_account") return null;
  const clientEmail = typeof record.client_email === "string" ? record.client_email.trim() : "";
  const privateKey = typeof record.private_key === "string" ? record.private_key : "";
  const tokenUri = typeof record.token_uri === "string" && record.token_uri.trim() ? record.token_uri.trim() : DEFAULT_TOKEN_URI;
  if (!clientEmail.includes("@") || !privateKey.includes("PRIVATE KEY")) return null;
  // 鍵の取得先は Google の token endpoint だけ (設定の書き換えで鍵の署名を別の宛先へ送らせない)。
  if (!/^https:\/\/oauth2\.googleapis\.com\/token$/.test(tokenUri)) return null;
  return { clientEmail, privateKey, tokenUri };
}
