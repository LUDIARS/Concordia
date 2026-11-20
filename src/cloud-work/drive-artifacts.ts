import { readCloudResponse } from "./artifact-transfer.js";
import type { AccessTokenSource } from "./google-oauth.js";
import type { CloudTarget } from "./runtime-config.js";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const ATTEMPT = /^[A-Za-z0-9_-]{1,100}$/;
type DriveTarget = Pick<CloudTarget, "id" | "sourceRevision" | "maxArtifactBytes"> & { drive?: { folderId: string } };
type DriveFile = { id?: unknown; size?: unknown; sha256Checksum?: unknown; appProperties?: { ccName?: unknown } };
export interface ColabCheckpoint { name: string; bytes: number; sha256: string; uri: string }

/**
 * @implements CC-CLOUD-DRIVE-02 CC-CLOUD-DRIVE-03
 * Drive counterpart of the S3 transfer. Cc opens one resumable upload session per expected file with its
 * own credential; only the session URLs (single-file capabilities) reach the worker. Collection lists the
 * attempt's files by Cc-assigned appProperties, then reads bytes under the same budget as S3.
 */
export class DriveCloudArtifacts {
  private readonly folderId: string;
  constructor(private readonly target: DriveTarget, private readonly names: readonly string[],
    private readonly tokens: AccessTokenSource, private readonly fetcher: typeof fetch = fetch) {
    if (!target.drive) throw new Error("cloud_drive_transfer_not_selected");
    if (names.length === 0) throw new Error("cloud_drive_transfer_not_selected");
    this.folderId = target.drive.folderId;
  }

  private files(attempt: string): string[] {
    if (!ATTEMPT.test(attempt)) throw new Error("invalid_cloud_object");
    return [...this.names, "result.json"];
  }

  private async openSession(token: string, attempt: string, name: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true`, {
        method: "POST", redirect: "error", signal: this.deadline(signal),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: `${attempt}-${name}`, parents: [this.folderId],
          appProperties: { ccTarget: this.target.id, ccAttempt: attempt, ccName: name } }),
      });
    } catch { throw new Error("cloud_drive_upload_unavailable"); }
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!response.ok || !location || !location.startsWith(`${UPLOAD}?`)) throw new Error("cloud_drive_upload_unavailable");
    return location;
  }

  async uploadInstructions(attempt: string): Promise<string> {
    const uploads = await this.uploadTargets(attempt, this.files(attempt));
    return ["Private Google Drive upload capability. Each URL accepts exactly one file. Do not log or commit these URLs.",
      "Upload each file with a single HTTP PUT of its exact bytes (Content-Length set, no other auth). Upload result.json LAST.",
      "Never retry with a different attempt ID or upload a file under another name.",
      `Manifest: {version:1,attemptId:"${attempt}",sourceRevision:"${this.target.sourceRevision}",status:"completed",artifacts:[{name,bytes,sha256}]}.`,
      `Manifest artifacts list exactly these Drive files: ${JSON.stringify(this.names)} (result.json excluded).`,
      `Total Drive output budget: ${this.target.maxArtifactBytes} bytes.`, JSON.stringify(uploads)].join("\n");
  }

  async checkpointUploads(attempt: string, signal?: AbortSignal): Promise<Array<{ name: string; url: string }>> {
    return this.uploadTargets(attempt, this.names, signal);
  }

  private async uploadTargets(attempt: string, names: readonly string[], signal?: AbortSignal): Promise<Array<{ name: string; url: string }>> {
    if (!ATTEMPT.test(attempt)) throw new Error("invalid_cloud_object");
    const token = await this.tokens.accessToken();
    const uploads: Array<{ name: string; url: string }> = [];
    for (const name of names) uploads.push({ name, url: await this.openSession(token, attempt, name, signal) });
    return uploads;
  }

  private deadline(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(30_000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async listOwned(token: string, attempt: string, fields: string, signal?: AbortSignal): Promise<DriveFile[]> {
    if (!ATTEMPT.test(attempt)) throw new Error("invalid_cloud_object");
    const query = `'${this.folderId}' in parents and trashed = false`
      + ` and appProperties has { key='ccTarget' and value='${this.target.id}' }`
      + ` and appProperties has { key='ccAttempt' and value='${attempt}' }`;
    const params = new URLSearchParams({ q: query, fields, pageSize: "100",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    let listed: unknown;
    try {
      listed = JSON.parse((await readCloudResponse(await this.fetcher(`${API}?${params}`, {
        headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: this.deadline(signal),
      }), 256_000)).toString("utf8"));
    } catch { throw new Error("cloud_artifact_collection_failed"); }
    const files = (listed as { files?: unknown; nextPageToken?: unknown } | null);
    if (!Array.isArray(files?.files) || files.nextPageToken) throw new Error("cloud_artifact_collection_failed");
    return files.files as DriveFile[];
  }

  /** Metadata-only verification avoids copying a checkpoint into Concordia. */
  async verifyCheckpoints(attempt: string, reported: readonly Omit<ColabCheckpoint, "uri">[], signal?: AbortSignal): Promise<ColabCheckpoint[]> {
    const files = await this.listOwned(await this.tokens.accessToken(), attempt,
      "nextPageToken,files(id,appProperties,size,sha256Checksum)", signal);
    const matches = new Map<string, DriveFile>();
    for (const file of files) {
      const name = file.appProperties?.ccName;
      if (typeof name !== "string" || !this.names.includes(name) || matches.has(name)) throw new Error("cloud_drive_artifact_ambiguous");
      matches.set(name, file);
    }
    return reported.map(entry => {
      const file = matches.get(entry.name);
      if (typeof file?.id !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(file.id)
        || file.size !== String(entry.bytes) || file.sha256Checksum !== entry.sha256) {
        throw new Error("cloud_artifact_integrity_failed");
      }
      return { ...entry, uri: `https://drive.google.com/open?id=${file.id}` };
    });
  }

  /** Maps each expected name to exactly one Drive file id; duplicates or strays are ambiguous, never guessed. */
  private async locate(token: string, attempt: string): Promise<Map<string, string>> {
    const expected = new Set(this.files(attempt));
    const found = new Map<string, string>();
    for (const file of await this.listOwned(token, attempt, "nextPageToken,files(id,appProperties)")) {
      const name = file.appProperties?.ccName;
      if (typeof file.id !== "string" || typeof name !== "string" || !expected.has(name) || found.has(name)) {
        throw new Error("cloud_drive_artifact_ambiguous");
      }
      found.set(name, file.id);
    }
    return found;
  }

  async collect(attempt: string): Promise<{ manifest: unknown; received: Map<string, Buffer> }> {
    const token = await this.tokens.accessToken();
    const ids = await this.locate(token, attempt);
    const get = async (name: string, limit: number): Promise<Buffer> => {
      const id = ids.get(name);
      if (!id) throw new Error("cloud_artifact_unavailable");
      try {
        return await readCloudResponse(await this.fetcher(`${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
          headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(60_000),
        }), limit);
      } catch { throw new Error("cloud_artifact_collection_failed"); }
    };
    const manifest: unknown = JSON.parse((await get("result.json", 32_000)).toString("utf8"));
    const received = new Map<string, Buffer>();
    let remaining = this.target.maxArtifactBytes;
    for (const name of this.names) {
      const bytes = await get(name, remaining);
      remaining -= bytes.length;
      received.set(name, bytes);
    }
    return { manifest, received };
  }
}
