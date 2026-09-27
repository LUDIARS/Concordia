import { resolve } from "node:path";

export const HUMAN_CONVERSATION_KEY = "cc_context_human_conversation";
export const EXPLICIT_CONTEXT_BINDING_KEY = "cc_context_explicit_binding";

export interface ExplicitContextBinding {
  repoPath: string;
  repoOrigin: string | null;
  branch: string | null;
  projectCode: string;
}

export interface ContextSessionBinding {
  repo_path: string;
  repo_origin: string | null;
  branch: string | null;
  metadata: string | null;
}

function metadataRecord(metadata: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(metadata ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Ignore unrelated metadata churn while rejecting stale presence and target evidence. */
export function contextEvidenceKey(metadata: string | null): string {
  const record = metadataRecord(metadata);
  return JSON.stringify([record[HUMAN_CONVERSATION_KEY] ?? null, record[EXPLICIT_CONTEXT_BINDING_KEY] ?? null]);
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    === resolve(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** A startup cwd and a guessed project code do not establish either prerequisite. */
export function hasConfirmedContextPresence(session: ContextSessionBinding, projectCode: string): boolean {
  const metadata = metadataRecord(session.metadata);
  if (metadata[HUMAN_CONVERSATION_KEY] !== true) return false;
  const binding = metadata[EXPLICIT_CONTEXT_BINDING_KEY];
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const item = binding as Record<string, unknown>;
  return typeof item.repoPath === "string" && samePath(item.repoPath, session.repo_path)
    && (item.repoOrigin ?? null) === session.repo_origin
    && (item.branch ?? null) === session.branch
    && item.projectCode === projectCode;
}
