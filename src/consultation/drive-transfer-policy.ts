/**
 * 相談のファイル受け渡し (Google Drive) の判断 (spec/feature/tech-consultation.md §6.4)。
 *
 * 受け渡すファイルの種類 (3D モデル・音声)・大きさ・名前、 Drive フォルダの共有の権限、 フォルダ名、 取り込み先を決める。
 * 副作用を持たない。 Drive の呼び出しは drive-transfer-service.ts、 REST は google-drive-client.ts が持つ。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { basename, join } from "node:path";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:6a57947e */
import augurContract_993c08f1 from './drive-transfer-file.contract.js'; /* augur-inject:contract-predicate:61a70fb7 */
import augurContract_5c3d2eda from './drive-transfer-permission.contract.js'; /* augur-inject:contract-predicate:848409c7 */

export const DRIVE_TRANSFER_MODEL_EXTENSIONS: readonly string[] = Object.freeze([
  ".fbx", ".obj", ".glb", ".gltf", ".blend", ".vrm", ".stl", ".dae", ".3ds", ".usdz", ".usd", ".ply", ".abc", ".max", ".ma", ".mb",
]);

export const DRIVE_TRANSFER_AUDIO_EXTENSIONS: readonly string[] = Object.freeze([
  ".wav", ".mp3", ".ogg", ".flac", ".aif", ".aiff", ".m4a", ".opus",
]);

/** 1 ファイルの上限 (200 MB)。 取り込みはメモリに載せて書くので上限を持つ。 */
export const DRIVE_TRANSFER_MAX_BYTES = 200 * 1024 * 1024;

/** Drive フォルダ・ファイルのアプリのプロパティ (状態は Drive が持つ)。 */
export const DRIVE_PROP_CONSULTATION = "ccConsultationId";
export const DRIVE_PROP_IMPORTED = "ccImported";
export const DRIVE_PROP_KIND = "ccKind";
export const DRIVE_PROP_SOURCE_NAME = "ccSourceName";
export const DRIVE_KIND_ANSWER = "answer";

export type TransferFileKind = "model" | "audio";
export type TransferFileRejection = "unsupported_type" | "too_large" | "invalid_name";
export type TransferFileDecision =
  | { ok: true; kind: TransferFileKind; fileName: string }
  | { ok: false; reason: TransferFileRejection };

/**
 * 受け渡してよいファイルか。 名前はファイル名部分だけを使い (パスを辿らせない)、 3D モデルか音声で上限以下のものだけを通す。
 * 大きさが分からない (null) ものは取り込み時に実際の長さで見直す。
 */
export function classifyTransferFile(input: { name: string; size: number | null }): TransferFileDecision {
  const fileName = sanitizeTransferFileName(input.name);
  if (!fileName) return { ok: false, reason: "invalid_name" };
  const kind = transferFileKind(fileName);
  if (!kind) return { ok: false, reason: "unsupported_type" };
  if (input.size !== null && (!Number.isFinite(input.size) || input.size < 0 || input.size > DRIVE_TRANSFER_MAX_BYTES)) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, kind, fileName };
}
// @ts-expect-error augur-inject
classifyTransferFile = contract(classifyTransferFile, { ...augurContract_993c08f1, contractId: 'consult-drive-C-1', mode: 'observe', sample: 1, where: 'src/consultation/drive-transfer-policy.ts:40', rule: 'contract-wrap', id: '993c08f1' }); /* augur-inject:contract-wrap:993c08f1 */

export function transferFileKind(fileName: string): TransferFileKind | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = fileName.slice(dot).toLowerCase();
  if (DRIVE_TRANSFER_MODEL_EXTENSIONS.includes(extension)) return "model";
  if (DRIVE_TRANSFER_AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return null;
}

/**
 * 保存に使えるファイル名。 区切り文字と制御文字・Windows で使えない文字を落とし、 ファイル名部分だけを返す。
 * 空・`.` / `..`・Windows の予約名は null。
 */
export function sanitizeTransferFileName(name: string): string | null {
  const last = basename(name.replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "").replace(/[. ]+$/, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned)) return null;
  return cleaned.length > 200 ? null : cleaned;
}

export interface DriveFolderPermission {
  type: "user";
  role: "writer";
  emailAddress: string;
}

/**
 * 相談フォルダの共有。 相談者の Google アカウントへの編集者だけで、 リンク共有 (anyone) やドメイン共有は作らない。
 * メールアドレスとして読めなければ null (共有しない)。
 */
export function driveFolderPermission(email: string): DriveFolderPermission | null {
  const address = email.trim();
  if (address.length > 254 || !/^[^\s@<>()",;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(address)) {
    return null;
  }
  return { type: "user", role: "writer", emailAddress: address };
}
// @ts-expect-error augur-inject
driveFolderPermission = contract(driveFolderPermission, { ...augurContract_5c3d2eda, contractId: 'consult-drive-C-2', mode: 'observe', sample: 1, where: 'src/consultation/drive-transfer-policy.ts:83', rule: 'contract-wrap', id: '5c3d2eda' }); /* augur-inject:contract-wrap:5c3d2eda */

/** Drive のフォルダ名。 内容を含めない (`相談-<日付>-<短い id>`、 チャンネル名と同じ形)。 */
export function consultDriveFolderName(now: Date, consultationId: string): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = consultationId.replace(/^pc_/, "").slice(0, 6);
  return `相談-${date}-${suffix}`;
}

/** 相談者のデータフォルダの中の受け渡し先。 */
export function consultTransferDirs(dataDir: string): { incoming: string; outgoing: string } {
  return { incoming: join(dataDir, "transfer", "incoming"), outgoing: join(dataDir, "transfer", "outgoing") };
}

const REJECTION_TEXT: Readonly<Record<TransferFileRejection, string>> = {
  unsupported_type: "3D モデル・音声以外",
  too_large: "200 MB 超",
  invalid_name: "使えない名前",
};

export function transferRejectionText(reason: TransferFileRejection): string {
  return REJECTION_TEXT[reason];
}
