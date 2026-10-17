import { createHash } from "node:crypto";

export interface VerifiedCloudArtifact { name: string; bytes: number; sha256: string }

/** @implements CC-CLOUD-05 — byte integrity is not model quality or human acceptance. */
export function verifyCloudArtifacts(input: {
  manifest: unknown;
  attemptId: string;
  sourceRevision: string;
  expectedNames: readonly string[];
  maxTotalBytes: number;
  received: ReadonlyMap<string, Uint8Array>;
}): { state: "artifacts_verified"; artifacts: VerifiedCloudArtifact[] } {
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
    const content = input.received.get(item.name);
    total += item.bytes;
    if (!content || content.byteLength !== item.bytes || total > input.maxTotalBytes
      || createHash("sha256").update(content).digest("hex") !== item.sha256) {
      throw new Error("cloud_artifact_integrity_failed");
    }
    artifacts.push({ name: item.name, bytes: item.bytes, sha256: item.sha256 });
  }
  return { state: "artifacts_verified", artifacts };
}
