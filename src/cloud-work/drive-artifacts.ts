import { readCloudResponse } from "./artifact-transfer.js";
import type { AccessTokenSource } from "./google-oauth.js";
import type { CloudTarget } from "./runtime-config.js";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const ATTEMPT = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * @implements CC-CLOUD-DRIVE-02 CC-CLOUD-DRIVE-03
 * Drive counterpart of the S3 transfer. Cc opens one resumable upload session per expected file with its
 * own credential; only the session URLs (single-file capabilities) reach the worker. Collection lists the
 * attempt's files by Cc-assigned appProperties, then reads bytes under the same budget as S3.
 */
export class DriveCloudArtifacts {
  private readonly folderId: string;
  constructor(private readonly target: CloudTarget, private readonly names: readonly string[],
    private readonly tokens: AccessTokenSource, private readonly fetcher: typeof fetch = fetch) {
    if (!target.drive) throw new Error("cloud_drive_transfer_not_selected");
    if (names.length === 0) throw new Error("cloud_drive_transfer_not_selected");
    this.folderId = target.drive.folderId;
  }

  private files(attempt: string): string[] {
    if (!ATTEMPT.test(attempt)) throw new Error("invalid_cloud_object");
    return [...this.names, "result.json"];
  }

  private async openSession(token: string, attempt: string, name: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
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
    const files = this.files(attempt);
    const token = await this.tokens.accessToken();
    const uploads: Array<{ name: string; url: string }> = [];
    for (const name of files) uploads.push({ name, url: await this.openSession(token, attempt, name) });
    return ["Private Google Drive upload capability. Each URL accepts exactly one file. Do not log or commit these URLs.",
      "Upload each file with a single HTTP PUT of its exact bytes (Content-Length set, no other auth). Upload result.json LAST.",
      "Never retry with a different attempt ID or upload a file under another name.",
      `Manifest: {version:1,attemptId:"${attempt}",sourceRevision:"${this.target.sourceRevision}",status:"completed",artifacts:[{name,bytes,sha256}]}.`,
      `Manifest artifacts list exactly these Drive files: ${JSON.stringify(this.names)} (result.json excluded).`,
      `Total Drive output budget: ${this.target.maxArtifactBytes} bytes.`, JSON.stringify(uploads)].join("\n");
  }

  /** Maps each expected name to exactly one Drive file id; duplicates or strays are ambiguous, never guessed. */
  private async locate(token: string, attempt: string): Promise<Map<string, string>> {
    const query = `'${this.folderId}' in parents and trashed = false`
      + ` and appProperties has { key='ccTarget' and value='${this.target.id}' }`
      + ` and appProperties has { key='ccAttempt' and value='${attempt}' }`;
    const params = new URLSearchParams({ q: query, fields: "files(id,appProperties)", pageSize: "100",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    let listed: unknown;
    try {
      listed = JSON.parse((await readCloudResponse(await this.fetcher(`${API}?${params}`, {
        headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
      }), 256_000)).toString("utf8"));
    } catch { throw new Error("cloud_artifact_collection_failed"); }
    const files = (listed as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) throw new Error("cloud_artifact_collection_failed");
    const expected = new Set(this.files(attempt));
    const found = new Map<string, string>();
    for (const file of files as Array<{ id?: unknown; appProperties?: { ccName?: unknown } }>) {
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
