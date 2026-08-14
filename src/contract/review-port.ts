import type { SessionContract, ContractField } from "./schema.js";
export interface ContractReviewInput {
  trigger?: "spawn" | "task-change";
  task: string;
  repoPath: string;
  unresolved: ContractField[];
  seeded: SessionContract;
}
export interface ContractReviewPort { review(input: ContractReviewInput): Promise<Partial<SessionContract>>; }
