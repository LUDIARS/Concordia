import { readFile } from "node:fs/promises";
import { z } from "zod";

const Name = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]+$/);
const ArtifactName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/).refine(x => x !== "result.json");
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
  codexExecutable: z.string().optional(), claudeExecutable: z.string().optional(),
  expectedNames: z.array(ArtifactName).min(1).max(20),
  /** Non-code outputs returned through Drive while code travels by Git. */
  driveExpectedNames: z.array(ArtifactName).min(1).max(20).optional(),
  maxArtifactBytes: z.number().int().positive().max(512_000_000),
  transferMode: z.enum(["git", "s3", "drive"]).default("git"),
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
  /** Existing Drive folder; Cc's own OAuth credential issues per-file upload sessions. */
  drive: z.object({
    folderId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
    clientIdEnv: EnvName, clientSecretEnv: EnvName, refreshTokenEnv: EnvName,
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  transferBindingIssues(value).forEach(message => ctx.addIssue({ code: "custom", message }));
  if (new Set(value.expectedNames).size !== value.expectedNames.length) ctx.addIssue({ code: "custom", message: "duplicate artifact name" });
});
export type CloudTarget = z.infer<typeof CloudTargetSchema>;
type TransferBindings = Pick<Partial<CloudTarget>, "transferMode" | "git" | "storage" | "drive" | "provider"
  | "codexExecutable" | "claudeExecutable" | "expectedNames" | "driveExpectedNames">;

/** @implements CC-CLOUD-DRIVE-01 — pure policy shared by fixed targets and environments whose work is supplied per run. */
function transferBindingIssues(value: TransferBindings): string[] {
  const issues: string[] = [];
  if (value.transferMode === "git" && !value.git) issues.push("Git return binding required");
  if (value.transferMode === "s3" && !value.storage) issues.push("S3 return binding required");
  if (value.transferMode === "drive" && !value.drive) issues.push("Drive return binding required");
  const driveNames = value.driveExpectedNames;
  if (driveNames && (value.transferMode !== "git" || !value.drive)) {
    issues.push("Drive artifact names require Git transfer with a Drive binding");
  }
  if (driveNames && new Set(driveNames).size !== driveNames.length) issues.push("duplicate Drive artifact name");
  if (driveNames && value.expectedNames?.some(name => driveNames.includes(name))) {
    issues.push("artifact name assigned to both Git and Drive");
  }
  if (value.provider === "codex-cloud" && (!value.codexExecutable || /\.(cmd|bat|ps1)$/i.test(value.codexExecutable))) {
    issues.push("native codex executable required");
  }
  if (value.provider === "claude-cloud" && (!value.claudeExecutable || /\.(cmd|bat|ps1)$/i.test(value.claudeExecutable))) {
    issues.push("native claude executable required");
  }
  return issues;
}

/** Files the worker uploads to Drive: every output in Drive mode, only the non-code outputs beside Git. */
export function driveArtifactNames(target: CloudTarget): string[] {
  if (target.transferMode === "drive") return target.expectedNames;
  return target.transferMode === "git" && target.drive ? target.driveExpectedNames ?? [] : [];
}

/** Work varies per request. It is not mandatory operator environment configuration. */
export const CloudWorkPlanSchema = CloudTargetSchema.innerType().pick({ sourceRevision: true, repositoryBytes: true,
  preparationEvidence: true, verifiedAt: true, expectedNames: true, driveExpectedNames: true, maxArtifactBytes: true }).strict();
export type CloudWorkPlan = z.infer<typeof CloudWorkPlanSchema>;
export const CloudEnvironmentSchema = CloudTargetSchema.innerType().partial({ sourceRevision: true, repositoryBytes: true,
  preparationEvidence: true, verifiedAt: true, expectedNames: true, maxArtifactBytes: true }).superRefine((value, ctx) => {
  transferBindingIssues(value).forEach(message => ctx.addIssue({ code: "custom", message }));
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
  const storage = target.storage, drive = target.drive;
  const driveReady = !!drive && !!env[drive.clientIdEnv] && !!env[drive.clientSecretEnv] && !!env[drive.refreshTokenEnv];
  const transferReady = target.transferMode === "git" ? !!target.git && !!env[target.git.accessHeaderEnv] && (!drive || driveReady)
    : target.transferMode === "drive" ? driveReady
      : !!storage && !!env[storage.accessKeyEnv] && !!env[storage.secretKeyEnv]
        && (!storage.sessionTokenEnv || !!env[storage.sessionTokenEnv]);
  return age >= 0 && age <= 24 * 60 * 60 * 1000 && transferReady;
}
