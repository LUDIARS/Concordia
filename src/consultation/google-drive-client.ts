/**
 * Google Drive REST v3 によるファイル受け渡しのポートの実装 (spec/feature/tech-consultation.md §6.4)。
 *
 * フォルダは相談者が自分の Drive (共有ドライブのこともある) に用意してサービスアカウントへ共有したものなので、
 * 全ての呼び出しに `supportsAllDrives=true` を付ける。 フォルダを作る・共有する呼び出しは持たない。
 * 失敗時の例外には応答本文を載せない (トークン・相談のファイル名をログへ流さない)。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { randomUUID } from "node:crypto";
import { DriveTransferError, type DriveFile, type DriveFolder, type DriveFolderInfo, type DriveTransferPort } from "./drive-transfer-port.js";
import type { AccessTokenSource, FetchLike } from "./google-service-account-token.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "files(id,name,mimeType,size,appProperties)";

/** Drive の検索式に埋める文字列 (`'` と `\` を逃がす)。 */
export function driveQueryLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function createGoogleDriveClient(tokens: AccessTokenSource, fetchImpl: FetchLike = fetch): DriveTransferPort {
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const response = await send(url, init);
    if (response.status === 404) throw new DriveTransferError("rejected", 404);
    return response;
  };
  /** 404 をそのまま返す (届かないフォルダを null で表すため)。 */
  const send = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const token = await tokens.token();
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
    } catch {
      throw new DriveTransferError("unreachable", null);
    }
    if (response.status === 401 || response.status === 403) throw new DriveTransferError("unauthorized", response.status);
    if (!response.ok && response.status !== 404) throw new DriveTransferError("rejected", response.status);
    return response;
  };
  const json = async <T>(response: Response): Promise<T> => {
    const body = await response.json().catch(() => null) as T | null;
    if (!body || typeof body !== "object") throw new DriveTransferError("malformed_response", response.status);
    return body;
  };
  const query = (params: Record<string, string>): string =>
    new URLSearchParams({ supportsAllDrives: "true", ...params }).toString();
  const toFolder = (body: { id?: unknown; webViewLink?: unknown }, status: number): DriveFolder => {
    if (typeof body.id !== "string") throw new DriveTransferError("malformed_response", status);
    return { id: body.id, url: typeof body.webViewLink === "string" ? body.webViewLink : `https://drive.google.com/drive/folders/${body.id}` };
  };

  return {
    async getFolder(folderId): Promise<DriveFolderInfo | null> {
      const response = await send(`${API}/files/${encodeURIComponent(folderId)}?${query({ fields: "id,webViewLink,mimeType,trashed,capabilities(canAddChildren),appProperties" })}`);
      if (response.status === 404) return null;
      const body = await json<{ mimeType?: unknown; trashed?: unknown; capabilities?: { canAddChildren?: unknown }; appProperties?: unknown; id?: unknown; webViewLink?: unknown }>(response);
      return {
        ...toFolder(body, response.status),
        mimeType: typeof body.mimeType === "string" ? body.mimeType : "",
        trashed: body.trashed === true,
        canAddChildren: body.capabilities?.canAddChildren === true,
        appProperties: body.appProperties && typeof body.appProperties === "object" ? body.appProperties as Record<string, string> : {},
      };
    },
    async findFolders(property) {
      const q = [
        `mimeType = '${FOLDER_MIME}'`,
        `appProperties has { key=${driveQueryLiteral(property.key)} and value=${driveQueryLiteral(property.value)} }`,
        "trashed = false",
      ].join(" and ");
      const response = await call(`${API}/files?${query({ q, fields: "files(id,webViewLink)", corpora: "allDrives", includeItemsFromAllDrives: "true", pageSize: "10" })}`);
      const body = await json<{ files?: Array<{ id?: unknown; webViewLink?: unknown }> }>(response);
      return (body.files ?? []).map((file) => toFolder(file, response.status));
    },
    async listFiles(folderId) {
      const files: DriveFile[] = [];
      let pageToken: string | null = null;
      do {
        const params: Record<string, string> = {
          q: `${driveQueryLiteral(folderId)} in parents and trashed = false`,
          fields: `nextPageToken,${FILE_FIELDS}`,
          includeItemsFromAllDrives: "true",
          pageSize: "200",
        };
        if (pageToken) params.pageToken = pageToken;
        const response = await call(`${API}/files?${query(params)}`);
        const body = await json<{ nextPageToken?: unknown; files?: Array<Record<string, unknown>> }>(response);
        for (const raw of body.files ?? []) {
          if (typeof raw.id !== "string" || typeof raw.name !== "string") continue;
          const size = typeof raw.size === "string" && /^\d+$/.test(raw.size) ? Number(raw.size) : null;
          const props = raw.appProperties && typeof raw.appProperties === "object" ? raw.appProperties as Record<string, string> : {};
          files.push({ id: raw.id, name: raw.name, mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "", size, appProperties: props });
        }
        pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
      } while (pageToken);
      return files;
    },
    async download(fileId) {
      const response = await call(`${API}/files/${encodeURIComponent(fileId)}?${query({ alt: "media" })}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async setAppProperties(fileId, appProperties) {
      await call(`${API}/files/${encodeURIComponent(fileId)}?${query({ fields: "id" })}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appProperties }),
      });
    },
    async upload(folderId, input) {
      const boundary = `cc-${randomUUID()}`;
      const metadata = JSON.stringify({ name: input.name, parents: [folderId], appProperties: input.appProperties });
      const head = Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
        + `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
        "utf8",
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      const response = await call(`${UPLOAD_API}/files?${query({ uploadType: "multipart", fields: "id" })}`, {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body: Buffer.concat([head, Buffer.from(input.bytes), tail]),
      });
      const body = await json<{ id?: unknown }>(response);
      if (typeof body.id !== "string") throw new DriveTransferError("malformed_response", response.status);
      return { id: body.id };
    },
  };
}
