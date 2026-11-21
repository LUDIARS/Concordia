import type { ConfluxSelection } from "../harness/reliability/conflux-policy.js";
import type { BuildIdentity } from "./policy.js";

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

export interface BuildJob extends BuildInput, BuildIdentity {}

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
