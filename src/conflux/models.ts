import type { ConfluxSelection } from "../harness/reliability/conflux-policy.js";
import type { BuildIdentity } from "./policy.js";
import type { MergeReturnTarget } from "./merge-return-policy.js";

export interface Destination {
  kind: "subsidiary" | "discord" | "slack";
  address: Record<string, string>;
}

export interface SpawnInput {
  idempotency_key: string;
  project_code: string;
  destination: Destination;
  selection: ConfluxSelection;
  title: string;
  brief: string;
  requested_by: string;
  source_comments: { id: string; author: string; body: string }[];
}

export interface BuildInput {
  dedupe_key: string;
  project_code: string;
  tide: string;
  variant: string;
  commit: string;
  branch?: string;
  platforms: string[];
}

interface ConfluxBuildJob extends BuildInput, BuildIdentity {
  merge_return?: never;
}

export interface MergeReturnBuildInput extends MergeReturnTarget {
  dedupe_key: string;
  platforms: string[];
}

export type BuildJob = ConfluxBuildJob | (MergeReturnBuildInput & { commit: string; merge_return: true });

export interface SessionReceipt {
  accepted: true;
  session_id: string;
  run_id: string;
  status: string;
}

export interface HookEvent {
  key: string;
  path: "/api/hooks/build-events" | "/api/hooks/integration";
  payload: object;
}
