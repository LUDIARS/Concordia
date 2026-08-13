import { z } from "zod";

export const DecisionSourceSchema = z.enum(["seed", "llm", "human"]);
export const ContractModeSchema = z.enum(["plan", "vibes"]);
export const ContractValueSchema = <T extends z.ZodTypeAny>(value: T) => z.object({
  value,
  decided_by: DecisionSourceSchema,
  rationale: z.string().min(1).max(4000),
  genius_card_ids: z.array(z.string().min(1).max(200)).max(100).default([]),
});
export const SessionContractSchema = z.object({
  version: z.literal(1),
  mode: ContractValueSchema(ContractModeSchema).nullable(),
  team: ContractValueSchema(z.string().min(1).max(200).nullable()).nullable(),
  model: ContractValueSchema(z.string().min(1).max(200)).nullable(),
  effort: ContractValueSchema(z.string().min(1).max(100)).nullable(),
  work_branch: ContractValueSchema(z.string().min(1).max(300)).nullable(),
  work_location: ContractValueSchema(z.enum(["worktree", "repo-root"])).nullable(),
  scope_dirs: ContractValueSchema(z.array(z.string().min(1).max(1000)).min(1).max(200)).nullable(),
  acceptance: ContractValueSchema(z.enum(["plan", "human-ok"])).nullable(),
  goal_and_go: ContractValueSchema(z.object({ enabled: z.boolean() })).nullable(),
  continuation: ContractValueSchema(z.enum(["requeue", "in-session"])).nullable(),
  testing_claim: ContractValueSchema(z.object({ required: z.boolean(), service: z.string().min(1).max(200).nullable() })).nullable(),
  supervisor: ContractValueSchema(z.string().min(1).max(300)).nullable(),
});
export type SessionContract = z.infer<typeof SessionContractSchema>;
export type ContractField = Exclude<keyof SessionContract, "version">;
export const CONTRACT_FIELDS = Object.keys(SessionContractSchema.shape).filter((key) => key !== "version") as ContractField[];

export function isContractComplete(contract: SessionContract | null | undefined): boolean {
  return !!contract && CONTRACT_FIELDS.every((field) => contract[field] !== null);
}

export function parseContractMetadata(raw: string | null): SessionContract | null {
  if (!raw) return null;
  try {
    const metadata = JSON.parse(raw) as { contract?: unknown };
    const parsed = SessionContractSchema.safeParse(metadata.contract);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
