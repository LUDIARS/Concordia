import type { SessionsRepo } from "../db/sessions-repo.js";
import { SessionContractSchema, parseContractMetadata, type ContractField, type SessionContract } from "./schema.js";

export function saveContract(sessions: SessionsRepo, sessionId: string, contract: SessionContract, reason: string, now = Math.floor(Date.now() / 1000)): SessionContract {
  const validated = SessionContractSchema.parse(contract);
  sessions.mergeMetadata(sessionId, { contract: validated });
  sessions.appendEvent({ session_id: sessionId, ts: now, kind: "contract", payload: { reason, contract: validated } });
  return validated;
}

export function patchContractHuman(sessions: SessionsRepo, sessionId: string, patch: Partial<Record<ContractField, unknown>>, rationale: string): SessionContract | null {
  const row = sessions.findSession(sessionId); if (!row) return null;
  const current = parseContractMetadata(row.metadata); if (!current) return null;
  const candidate: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(patch)) candidate[field] = { value, decided_by: "human", rationale, genius_card_ids: [] };
  return saveContract(sessions, sessionId, SessionContractSchema.parse(candidate), "human-override");
}
