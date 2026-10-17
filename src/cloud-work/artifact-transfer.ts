import type { CloudTarget } from "./runtime-config.js";
import { signS3Object, type S3Credentials } from "./s3-signing.js";

/** Bounded response reading shared by binary artifacts and the small result manifest. */
export async function readCloudResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("cloud_artifact_unavailable"); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error("cloud_artifact_too_large"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export class S3CloudArtifacts {
  private readonly credentials: S3Credentials;
  private readonly storage: NonNullable<CloudTarget["storage"]>;
  constructor(private readonly target: CloudTarget, env: NodeJS.ProcessEnv,
    private readonly now: () => Date = () => new Date(), private readonly fetcher: typeof fetch = fetch) {
    const s = target.storage;
    if (target.transferMode !== "s3" || !s) throw new Error("cloud_s3_transfer_not_selected");
    this.storage = s;
    const accessKey = env[s.accessKeyEnv], secretKey = env[s.secretKeyEnv];
    if (!accessKey || !secretKey || (s.sessionTokenEnv && !env[s.sessionTokenEnv])) throw new Error("cloud_storage_credentials_missing");
    this.credentials = { accessKey, secretKey, sessionToken: s.sessionTokenEnv ? env[s.sessionTokenEnv] : undefined };
  }

  private object(attempt: string, name: string, method: "GET" | "PUT") {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(attempt)
      || ![...this.target.expectedNames, "result.json"].includes(name)) throw new Error("invalid_cloud_object");
    return signS3Object({ ...this.storage, credentials: this.credentials,
      key: `${this.storage.prefix}/${this.target.id}/${attempt}/${name}`, method,
      now: this.now(), expiresSeconds: method === "PUT" ? 3600 : 300 });
  }

  uploadInstructions(attempt: string): string {
    const uploads = [...this.target.expectedNames, "result.json"].map(name => ({ name, ...this.object(attempt, name, "PUT") }));
    return ["Private artifact upload capability (expires after one hour). Do not log or commit these URLs.",
      "PUT exact bytes with the listed headers; upload result.json LAST. Never overwrite or retry with a different attempt ID.",
      `Manifest: {version:1,attemptId:"${attempt}",sourceRevision:"${this.target.sourceRevision}",status:"completed",artifacts:[{name,bytes,sha256}]}.`,
      "Compute sizes and SHA-256 from actual output bytes. Manifest artifacts excludes result.json itself.",
      `Total output budget: ${this.target.maxArtifactBytes} bytes.`, JSON.stringify(uploads)].join("\n");
  }

  async collect(attempt: string): Promise<{ manifest: unknown; received: Map<string, Buffer> }> {
    const get = async (name: string, limit: number): Promise<Buffer> => {
      const signed = this.object(attempt, name, "GET");
      try {
        return await readCloudResponse(await this.fetcher(signed.url, {
          headers: signed.headers, redirect: "error", signal: AbortSignal.timeout(60_000),
        }), limit);
      } catch { throw new Error("cloud_artifact_collection_failed"); }
    };
    const manifest: unknown = JSON.parse((await get("result.json", 32_000)).toString("utf8"));
    const received = new Map<string, Buffer>();
    let remaining = this.target.maxArtifactBytes;
    for (const name of this.target.expectedNames) {
      const bytes = await get(name, remaining);
      remaining -= bytes.length;
      received.set(name, bytes);
    }
    return { manifest, received };
  }
}
