import { createHash } from "node:crypto";

export interface VerifiedCloudArtifact { name: string; bytes: number; sha256: string }

export function cloudArtifactManifest(input: {
  manifest: unknown;
  attemptId: string;
  sourceRevision: string;
  expectedNames: readonly string[];
  maxTotalBytes: number;
}): VerifiedCloudArtifact[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const manifest = input.manifest;
  if (!Number.isSafeInteger(input.maxTotalBytes) || input.maxTotalBytes < 1
    || input.expectedNames.length === 0 || new Set(input.expectedNames).size !== input.expectedNames.length
    || !isRecord(manifest) || manifest.version !== 1 || manifest.attemptId !== input.attemptId
    || manifest.sourceRevision !== input.sourceRevision || manifest.status !== "completed"
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== input.expectedNames.length) {
    throw new Error("invalid_cloud_artifact_manifest");
  }
  const expected = new Set(input.expectedNames);
  const artifacts: VerifiedCloudArtifact[] = [];
  let total = 0;
  for (const item of manifest.artifacts) {
    if (!isRecord(item) || typeof item.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(item.name)
      || !expected.delete(item.name) || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 1
      || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error("invalid_cloud_artifact_entry");
    }
    total += item.bytes;
    if (total > input.maxTotalBytes) {
      throw new Error("cloud_artifact_integrity_failed");
    }
    artifacts.push({ name: item.name, bytes: item.bytes, sha256: item.sha256 });
  }
  return artifacts;
}

/** @implements CC-CLOUD-05 */
export function verifyCloudArtifacts(input: Parameters<typeof cloudArtifactManifest>[0] & {
  received: ReadonlyMap<string, Uint8Array>;
}): { state: "artifacts_verified"; artifacts: VerifiedCloudArtifact[] } {
  const artifacts = cloudArtifactManifest(input);
  for (const { name, bytes, sha256 } of artifacts) {
    const content = input.received.get(name);
    if (!content || content.byteLength !== bytes || createHash("sha256").update(content).digest("hex") !== sha256) {
      throw new Error("cloud_artifact_integrity_failed");
    }
  }
  return { state: "artifacts_verified", artifacts };
}
