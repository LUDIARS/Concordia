// @spec ハーネス信頼性の実装境界
/** Bounded, session-local observations. Absence is unknown, never healthy. */
export interface HookObservation {
  at: number;
  status: string;
  reason: string;
}

export interface Checkpoint {
  id: string;
  at: number;
  trigger: string;
  text: string;
  restored_at?: number;
}

export interface PromptSample {
  id: string;
  user_key: string | null;
  user_label: string;
  at: number;
  stage: "initial" | "middle";
  turn: number;
  elapsed_minutes: number;
  provider: string;
  model: string | null;
  context_usage: number | null;
  after_compaction: boolean;
  prompt: string;
  context: string;
  status: "pending" | "assessed" | "unavailable";
  advice?: string;
}

export interface ReliabilityState {
  tools?: { seen: string[]; failure?: { fingerprint: string; count: number; at: number } };
  version: 1;
  observations: Record<string, HookObservation>;
  checkpoints: Checkpoint[];
  mcp: Record<string, HookObservation>;
  samples: PromptSample[];
  prompt_count: number;
  last_sample_slot: number;
  report?: { at: number; status: string; text?: string; message_id?: number };
}

export function emptyState(): ReliabilityState {
  return { version: 1, observations: {}, checkpoints: [], mcp: {}, samples: [], prompt_count: 0, last_sample_slot: -1 };
}

export function readState(metadata: Record<string, unknown>): ReliabilityState {
  const value = metadata.harness_reliability as ReliabilityState | undefined;
  if (!value) return emptyState();
  if (value.version !== 1 || !Array.isArray(value.checkpoints) || !Array.isArray(value.samples)
    || !value.observations || !value.mcp) throw new Error("invalid reliability state");
  return structuredClone(value);
}
