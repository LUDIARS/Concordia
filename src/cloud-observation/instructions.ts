import { ArtifactReceiver } from "../cloud-work/artifact-receiver.js";
import { findTailscaleAddress, isTailscaleAddress } from "../management/remote-config.js";
import { lstat } from "node:fs/promises";

export function observationSettings(env: NodeJS.ProcessEnv, address: () => string | null = findTailscaleAddress): { root: string; origin: string } | null {
  if (env.CONCORDIA_CLOUD_OBSERVATION_ENABLED !== "true") return null;
  const configured = env.CONCORDIA_CLOUD_OBSERVATION_URL;
  const host = !configured && env.CONCORDIA_CLOUD_OBSERVATION_HOST === "tailscale" ? address() : null;
  const url = new URL(configured ?? (host ? `http://${host}:${env.CONCORDIA_ARTIFACT_PORT}` : ""));
  if (!env.CONCORDIA_ARTIFACT_ROOT || url.protocol !== "http:" || !isTailscaleAddress(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || url.port !== env.CONCORDIA_ARTIFACT_PORT) throw new Error("cloud_observation_configuration_invalid");
  return { root: env.CONCORDIA_ARTIFACT_ROOT, origin: url.origin };
}

/** Check local readiness before reserving a submission or launching external compute. */
export async function preflightObservation(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<void> {
  const settings = observationSettings(env);
  if (!settings) return;
  const root = await lstat(settings.root);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("observation_root_invalid");
  try {
    const response = await fetcher(`${settings.origin}/health`, { redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("health_failed");
    const result = await response.json() as { service?: string; ok?: boolean; observations?: number };
    if (result.service !== "concordia-cloud-artifact" || result.ok !== true || result.observations !== 1) throw new Error("health_mismatch");
  } catch { throw new Error("cloud_observation_receiver_not_ready"); }
}

/** A transient capability: never add the returned instructions to persisted run metadata. */
export async function cloudObservationInstructions(env: NodeJS.ProcessEnv, target: string, attempt: string,
  now: number): Promise<string> {
  const settings = observationSettings(env);
  if (!settings) return "";
  const { token } = await new ArtifactReceiver(settings.root).issue({ target, attempt,
    name: "artifacts.tar", maxBytes: 512_000_000, issuedAt: now, expiresAt: now + 21_600_000 });
  const endpoint = `${settings.origin}/observations/${target}/${attempt}`;
  return [
    "CLOUD OBSERVATION (private run capability; never print, commit, or include it in logs):",
    `Endpoint: ${endpoint}`,
    `Authorization header: Bearer ${token}`,
    "Use the configured network/VPN route. Never change network access policy or expose a service to bypass connection errors.",
    "Send JSON by HTTP PUT, Content-Type application/json, exact Content-Length; use a UTF-8 body file, not a secret-bearing command line.",
    'Schema: {"id":"unique-event-id","sequence":1,"kind":"progress","message":"Short step summary"}. Sequence increases exactly by 1; persist it locally for this run.',
    "Send a heartbeat event every 30 seconds while computation runs. Use a single serial sender for heartbeats and progress events; do not race sequence allocation.",
    "Report progress at each modelling/build/render/training stage. Send summaries only: no raw command output, environment dump, credentials or personal data.",
    "For previews, PUT PNG/JPEG bytes (max 8 MiB) to endpoint/previews/unique-preview-id, application/octet-stream. Total previews max 32 MiB.",
    'After preview receipt send {id,sequence,kind:"preview",message:"Preview description",previewId:"unique-preview-id"}. Do not send external image URLs.',
    'For human decisions send {id,sequence,kind:"question",message:"Question",questionId:"unique-question-id"}; stop dependent work.',
    "Poll GET endpoint every 15 seconds for state.question.answer. Resume only for the matching question ID; keep sending heartbeats while waiting. Expiry, silence or an error is not approval.",
    "Send finished only after artifact upload succeeds, or failed with a brief error description. Finished is self-reported, not review approval.",
    "On lost PUT response, GET and reconcile lastEvent.id/sequence before resending; resend the identical event only. Never advance blindly.",
    "On endpoint/auth failure report observation unavailable in the cloud task; do not claim the forum received anything. Capability expires after six hours.",
  ].join("\n");
}
