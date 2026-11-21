import { createHash } from "node:crypto";
import { readCloudResponse } from "./artifact-transfer.js";
import { parseColabResult, type ColabArtifacts, type ColabReport } from "./colab-result.js";
import type { SiteColabRun } from "./colab-run.js";
import type { DriveCloudArtifacts } from "./drive-artifacts.js";
import type { ColabSiteTransport } from "./colab-site-excubitor.js";
import { SITE_RESULT_NAME, siteFileLimit, type SiteFile } from "./colab-site-schema.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:45a43a7c */
import augurContract_29836e53 from './colab-site-artifact.contract.js'; /* augur-inject:contract-predicate:6a7374d6 */

export function verifySiteArtifact(bytes: Buffer, expected: SiteFile): boolean {
  return bytes.length <= siteFileLimit(expected.name) && bytes.length === expected.bytes
    && createHash("sha256").update(bytes).digest("hex") === expected.sha256;
}
// @ts-expect-error augur-inject
verifySiteArtifact = contract(verifySiteArtifact, { ...augurContract_29836e53, contractId: 'cloud-colab-site-C-39', mode: 'observe', sample: 1, where: 'src/cloud-work/colab-site-artifacts.ts:9', rule: 'contract-wrap', id: '29836e53' }); /* augur-inject:contract-wrap:29836e53 */

export async function collectColabSiteArtifacts(run: SiteColabRun, transport: ColabSiteTransport,
  saveReport: (report: ColabReport) => void, drive?: () => DriveCloudArtifacts | undefined): Promise<ColabArtifacts> {
  const receipt = run.site.receipt;
  if (receipt?.phase !== "released" || !receipt.files.length) throw new Error("cloud_colab_collection_unready");
  const { peerId, outputNames } = run.binding.site;
  const files = await transport.manifest(peerId, receipt.id);
  const expected = new Map(receipt.files.map(file => [file.name, file]));
  if (files.length !== outputNames.length + 1 || files.length !== expected.size) throw new Error("cloud_artifact_integrity_failed");
  for (const file of files) {
    const entry = expected.get(file.name);
    if ((!outputNames.includes(file.name) && file.name !== SITE_RESULT_NAME) || entry?.bytes !== file.bytes || entry.sha256 !== file.sha256) {
      throw new Error("cloud_artifact_integrity_failed");
    }
  }
  const result = files.find(file => file.name === SITE_RESULT_NAME);
  if (!result) throw new Error("cloud_artifact_integrity_failed");

  const get = async (file: SiteFile): Promise<Buffer> => {
    const response = await transport.file(peerId, receipt.id, file.name);
    if (response.headers.get("content-type") !== "application/octet-stream"
      || response.headers.get("content-length") !== String(file.bytes) || response.headers.get("x-artifact-sha256") !== file.sha256) {
      await response.body?.cancel();
      throw new Error("cloud_artifact_integrity_failed");
    }
    // The declared size has already been bounded by the receipt schema. Stop as soon as the body exceeds it.
    const bytes = await readCloudResponse(response, file.bytes);
    if (!verifySiteArtifact(bytes, file)) throw new Error("cloud_artifact_integrity_failed");
    return bytes;
  };
  const report = parseColabResult(await get(result), run.requestId, run.sourceRevision, outputNames, "site");
  const outputs = files.filter(file => file.name !== SITE_RESULT_NAME);
  for (const file of outputs) {
    const declared = report.checkpoints.find(entry => entry.name === file.name);
    if (declared?.bytes !== file.bytes || declared.sha256 !== file.sha256) throw new Error("cloud_artifact_integrity_failed");
  }
  saveReport(report);
  for (const file of outputs) await get(file);
  const storage = drive?.();
  if (run.binding.drive && !storage) throw new Error("cloud_colab_collection_unready");
  const checkpoints = await storage?.collectReferences(run.requestId) ?? [];
  return { report, siteFiles: outputs, checkpoints };
}
