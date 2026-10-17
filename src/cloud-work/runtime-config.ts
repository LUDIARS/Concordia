import { readFile } from "node:fs/promises";
import { z } from "zod";

const Name = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]+$/);
export const CloudTargetSchema = z.object({
  id: Name, label: z.string().min(1).max(120), repoPath: z.string().min(1),
  subsidiaryId: z.string().nullable(),
  provider: z.enum(["codex-cloud", "claude-cloud"]), environmentId: Name,
  standardHosted: z.literal(true), publishedBranch: z.literal("main"),
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  repositoryBytes: z.number().int().min(0).max(50_000_000),
  preparationEvidence: z.string().min(1).max(2000), verifiedAt: z.string().datetime(),
  environmentPreparable: z.literal(true), requiresLargeProjectClone: z.literal(false),
  gpuVerified: z.boolean().default(false),
  codexExecutable: z.string().optional(), claudeTriggerId: z.string().regex(/^trig_[A-Za-z0-9]+$/).optional(),
  claudeTokenEnv: EnvName.optional(),
  expectedNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/).refine(x => x !== "result.json")).min(1).max(20),
  maxArtifactBytes: z.number().int().positive().max(512_000_000),
  transferMode: z.enum(["git", "s3"]).default("git"),
  git: z.object({
    publicHost: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i),
    accessHeaderEnv: EnvName,
    accessHeaderName: z.string().regex(/^X-[A-Za-z0-9-]{1,80}$/i),
  }).strict().optional(),
  storage: z.object({
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    prefix: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    accessKeyEnv: EnvName, secretKeyEnv: EnvName, sessionTokenEnv: EnvName.optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.transferMode === "git" && !value.git) ctx.addIssue({ code: "custom", message: "Git return binding required" });
  if (value.transferMode === "s3" && !value.storage) ctx.addIssue({ code: "custom", message: "S3 return binding required" });
  if (new Set(value.expectedNames).size !== value.expectedNames.length) ctx.addIssue({ code: "custom", message: "duplicate artifact name" });
  if (value.provider === "codex-cloud" && (!value.codexExecutable || /\.(cmd|bat|ps1)$/i.test(value.codexExecutable))) {
    ctx.addIssue({ code: "custom", message: "native codex executable required" });
  }
  if (value.provider === "claude-cloud" && (!value.claudeTriggerId || !value.claudeTokenEnv)) {
    ctx.addIssue({ code: "custom", message: "Claude routine binding required" });
  }
});
export type CloudTarget = z.infer<typeof CloudTargetSchema>;

/** Work varies per request. It is not mandatory operator environment configuration. */
export const CloudWorkPlanSchema = CloudTargetSchema.innerType().pick({ sourceRevision: true, repositoryBytes: true,
  preparationEvidence: true, verifiedAt: true, expectedNames: true, maxArtifactBytes: true }).strict();
export type CloudWorkPlan = z.infer<typeof CloudWorkPlanSchema>;
export const CloudEnvironmentSchema = CloudTargetSchema.innerType().partial({ sourceRevision: true, repositoryBytes: true,
  preparationEvidence: true, verifiedAt: true, expectedNames: true, maxArtifactBytes: true }).superRefine((value, ctx) => {
  if (value.transferMode === "git" && !value.git) ctx.addIssue({ code: "custom", message: "Git return binding required" });
  if (value.transferMode === "s3" && !value.storage) ctx.addIssue({ code: "custom", message: "S3 return binding required" });
  if (value.provider === "codex-cloud" && (!value.codexExecutable || /\.(cmd|bat|ps1)$/i.test(value.codexExecutable))) {
    ctx.addIssue({ code: "custom", message: "native codex executable required" });
  }
  if (value.provider === "claude-cloud" && (!value.claudeTriggerId || !value.claudeTokenEnv)) {
    ctx.addIssue({ code: "custom", message: "Claude routine binding required" });
  }
});
export type CloudEnvironment = z.infer<typeof CloudEnvironmentSchema>;

export function resolveCloudWork(target: CloudEnvironment, work?: CloudWorkPlan): CloudTarget {
  const parsed = CloudTargetSchema.safeParse({ ...target, ...work });
  if (!parsed.success) throw new Error("cloud_work_plan_required_or_invalid");
  return parsed.data;
}

/** Config is local operator input, never an untrusted request body. */
export async function readCloudTargets(path: string | undefined): Promise<CloudEnvironment[]> {
  if (!path) return [];
  try {
    const bytes = await readFile(path);
    if (bytes.length > 256_000) throw new Error("too_large");
    const targets = z.array(CloudEnvironmentSchema).max(50).parse(JSON.parse(bytes.toString("utf8")));
    if (new Set(targets.map(t => t.id)).size !== targets.length) throw new Error("duplicate_target");
    return targets;
  } catch { throw new Error("cloud_configuration_invalid"); }
}

export function cloudTargetReady(target: CloudEnvironment, env: NodeJS.ProcessEnv, now: number): boolean {
  const age = target.verifiedAt ? now - Date.parse(target.verifiedAt) : 0;
  const storage = target.storage;
  const transferReady = target.transferMode === "git" ? !!target.git && !!env[target.git.accessHeaderEnv]
    : !!storage && !!env[storage.accessKeyEnv] && !!env[storage.secretKeyEnv]
      && (!storage.sessionTokenEnv || !!env[storage.sessionTokenEnv]);
  return age >= 0 && age <= 24 * 60 * 60 * 1000
    && transferReady
    && (target.provider !== "claude-cloud" || !!env[target.claudeTokenEnv!]);
}
