import { randomUUID } from "node:crypto";
import { resolveExcubitorManagement } from "./excubitor-management.js";
import { readCloudResponse } from "./artifact-transfer.js";
import { type SiteFile, type SiteReceipt, type SiteSubmit, SiteManifestSchema, SiteReceiptSchema } from "./colab-site-schema.js";

export type SiteConnection = "cloud_colab_site_not_registered" | "cloud_colab_site_mesh_not_ready" | "cloud_colab_site_unreachable";
type SiteRefusal = SiteConnection | "cloud_colab_site_cli_unready" | "cloud_colab_site_busy"
  | "cloud_colab_site_program_mismatch" | "cloud_colab_site_start_refused";
export interface ColabSiteTransport {
  readiness(peer: string): Promise<SiteConnection | null>;
  submit(peer: string, input: SiteSubmit): Promise<{ receipt: SiteReceipt } | { refused: SiteRefusal }>;
  observe(peer: string, id: string): Promise<SiteReceipt>;
  cancel(peer: string, id: string): Promise<SiteReceipt>;
  manifest(peer: string, id: string): Promise<SiteFile[]>;
  file(peer: string, id: string, name: string): Promise<Response>;
}

const JSON_BYTES = 32 * 1024;
const REFUSALS = new Map<string, SiteRefusal>([
  ["404:colab_site_not_registered", "cloud_colab_site_not_registered"],
  ["502:mesh_security_not_configured", "cloud_colab_site_mesh_not_ready"],
  ["502:mesh_credential_not_configured", "cloud_colab_site_mesh_not_ready"],
  ["403:colab_peer_forbidden", "cloud_colab_site_mesh_not_ready"],
  ["403:colab_start_not_allowed", "cloud_colab_site_start_refused"],
  ["400:colab_invalid_submit", "cloud_colab_site_start_refused"],
  ["400:colab_deadline_elapsed", "cloud_colab_site_start_refused"],
  ["400:colab_program_mismatch", "cloud_colab_site_program_mismatch"],
  ["409:colab_site_busy", "cloud_colab_site_busy"],
  ["503:colab_not_ready", "cloud_colab_site_cli_unready"],
]);

async function json(response: Response, limit = JSON_BYTES): Promise<unknown> {
  const bytes = await readCloudResponse(new Response(response.body), limit);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function errorCode(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return "";
}

export function colabSiteTransport(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ColabSiteTransport {
  const pathFor = (peer: string, id?: string) => `/api/v1/colab/peers/${encodeURIComponent(peer)}/jobs`
    + (id ? `/${encodeURIComponent(id)}` : "");
  const call = async (path: string, body?: SiteSubmit | object) => {
    const endpoint = await resolveExcubitorManagement(env, fetcher, response => json(response, 2_000_000));
    return fetcher(new URL(path, endpoint), { redirect: "error", signal: AbortSignal.timeout(35_000),
      ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  };
  const read = async (path: string, body?: object) => {
    const response = await call(path, body);
    const value = await json(response);
    if (!response.ok) throw new Error("cloud_colab_site_observation_unavailable");
    return value;
  };
  return {
    async readiness(peer) {
      try {
        // A typed missing-job response establishes the peer route and reflect authorization without starting a job.
        const response = await call(pathFor(peer, randomUUID()));
        const code = errorCode(await json(response));
        if (response.status === 404 && code === "colab_job_missing") return null;
        const reason = REFUSALS.get(`${response.status}:${code}`);
        if (reason === "cloud_colab_site_not_registered" || reason === "cloud_colab_site_mesh_not_ready") return reason;
      } catch { /* The peer route did not produce verifiable readiness evidence. */ }
      return "cloud_colab_site_unreachable";
    },
    async submit(peer, input) {
      const response = await call(pathFor(peer), input);
      const value = await json(response);
      if (response.status === 200 || response.status === 202) return { receipt: SiteReceiptSchema.parse(value) };
      const refusal = REFUSALS.get(`${response.status}:${errorCode(value)}`);
      if (refusal) return { refused: refusal };
      // In particular, Excubitor's generic 502 can also mean the remote start already succeeded.
      throw new Error("cloud_colab_site_submission_unknown");
    },
    async observe(peer, id) { return SiteReceiptSchema.parse(await read(pathFor(peer, id))); },
    async cancel(peer, id) { return SiteReceiptSchema.parse(await read(pathFor(peer, id) + "/cancel", {})); },
    async manifest(peer, id) { return SiteManifestSchema.parse(await read(pathFor(peer, id) + "/collect", {})).files; },
    file: (peer, id, name) => call(pathFor(peer, id) + "/collect", { name }),
  };
}
