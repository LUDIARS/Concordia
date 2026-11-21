import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ColabBindingSchema } from "./colab-config.js";

const Name = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]+$/);
const ArtifactName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/).refine(x => x !== "result.json");
const CloudTargetInput = z.object({
  id: Name, label: z.string().min(1).max(120), repoPath: z.string().min(1),
  subsidiaryId: z.string().nullable(),
  provider: z.enum(["codex-cloud", "claude-cloud", "colab"]), environmentId: Name,
  standardHosted: z.literal(true), publishedBranch: z.literal("main"),
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  repositoryBytes: z.number().int().min(0).max(50_000_000),
  preparationEvidence: z.string().min(1).max(2000), verifiedAt: z.string().datetime(),
  environmentPreparable: z.literal(true), requiresLargeProjectClone: z.literal(false),
  gpuVerified: z.boolean().default(false),
  codexExecutable: z.string().optional(), claudeExecutable: z.string().optional(),
  claudeTriggerId: z.string().regex(/^trig_[A-Za-z0-9]+$/).optional(), claudeTokenEnv: EnvName.optional(),
  expectedNames: z.array(ArtifactName).min(1).max(20),
  /** Non-code outputs returned through Drive while code travels by Git. */
  driveExpectedNames: z.array(ArtifactName).min(1).max(20).optional(),
  maxArtifactBytes: z.number().int().positive().max(512_000_000),
  transferMode: z.enum(["git", "s3", "drive", "jupyter", "excubitor-site"]).optional(),
  colab: ColabBindingSchema.optional(),
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
}).strict();

function withTransferDefault<T extends Pick<z.infer<typeof CloudTargetInput>, "provider" | "transferMode">>(value: T) {
  return { ...value, transferMode: value.transferMode ?? (value.provider === "colab" ? "excubitor-site" : "git") };
}

export const CloudTargetSchema = CloudTargetInput.transform(withTransferDefault).superRefine((value, ctx) => {
  transferBindingIssues(value).forEach(message => ctx.addIssue({ code: "custom", message }));
  if (new Set(value.expectedNames).size !== value.expectedNames.length) ctx.addIssue({ code: "custom", message: "duplicate artifact name" });
});
export type CloudTarget = z.infer<typeof CloudTargetSchema>;
type TransferBindings = Pick<Partial<CloudTarget>, "transferMode" | "git" | "storage" | "drive" | "provider"
  | "codexExecutable" | "claudeExecutable" | "claudeTriggerId" | "claudeTokenEnv" | "expectedNames" | "driveExpectedNames" | "colab" | "sourceRevision">;

/** @implements CC-CLOUD-DRIVE-01 — pure policy shared by fixed targets and environments whose work is supplied per run. */
function transferBindingIssues(value: TransferBindings): string[] {
  const issues: string[] = [];
  if (value.provider === "colab") {
    const site = value.colab?.site;
    const valid = site ? value.transferMode === "excubitor-site" && /^[0-9a-f]{40}$/.test(value.sourceRevision ?? "")
      : value.transferMode === "jupyter" && !!value.sourceRevision;
    if (!value.colab || !valid || value.git || value.storage || value.drive) {
      issues.push("Colab requires a fixed source revision and a binding for the selected transport");
    }
    return issues;
  }
  if (value.colab || value.transferMode === "jupyter" || value.transferMode === "excubitor-site") {
    issues.push("Colab binding requires the Colab provider");
  }
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
  if (value.provider === "claude-cloud" && (!value.claudeExecutable || /\.(cmd|bat|ps1)$/i.test(value.claudeExecutable)
    || !value.claudeTriggerId || !value.claudeTokenEnv)) {
    issues.push("Claude routine and native claude executable required");
  }
  return issues;
}

/** Files the worker uploads to Drive: every output in Drive mode, only the non-code outputs beside Git. */
export function driveArtifactNames(target: CloudTarget): string[] {
  if (target.transferMode === "drive") return target.expectedNames;
  return target.transferMode === "git" && target.drive ? target.driveExpectedNames ?? [] : [];
}

/** Work varies per request. It is not mandatory operator environment configuration. */
export const CloudWorkPlanSchema = CloudTargetInput.pick({ sourceRevision: true, repositoryBytes: true,
  preparationEvidence: true, verifiedAt: true, expectedNames: true, driveExpectedNames: true, maxArtifactBytes: true }).strict();
export type CloudWorkPlan = z.infer<typeof CloudWorkPlanSchema>;
export const CloudEnvironmentSchema = CloudTargetInput.partial({ sourceRevision: true, repositoryBytes: true,
  preparationEvidence: true, verifiedAt: true, expectedNames: true, maxArtifactBytes: true })
  .transform(withTransferDefault).superRefine((value, ctx) => {
  transferBindingIssues(value).forEach(message => ctx.addIssue({ code: "custom", message }));
});
export type CloudEnvironment = z.infer<typeof CloudEnvironmentSchema>;

export function resolveCloudWork(target: CloudEnvironment, work?: CloudWorkPlan): CloudTarget {
  const parsed = CloudTargetSchema.safeParse({ ...target, ...work });
  if (!parsed.success) throw new Error("cloud_work_plan_required_or_invalid");
  return parsed.data;
}

/** `claude --cloud` runs in the account's Default environment; the ID only identifies the target. */
export const CLAUDE_DEFAULT_ENVIRONMENT = "claude-default";
function withClaudeDefaultEnvironment(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(entry => entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Record<string, unknown>).provider === "claude-cloud" && (entry as Record<string, unknown>).environmentId === undefined
    ? { ...entry, environmentId: CLAUDE_DEFAULT_ENVIRONMENT } : entry);
}

/** Config is local operator input, never an untrusted request body. A not-yet-created file means no targets. */
export async function readCloudTargets(path: string | undefined): Promise<CloudEnvironment[]> {
  if (!path) return [];
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("cloud_configuration_invalid");
  }
  try {
    if (bytes.length > 256_000) throw new Error("too_large");
    const targets = z.array(CloudEnvironmentSchema).max(50).parse(withClaudeDefaultEnvironment(JSON.parse(bytes.toString("utf8"))));
    if (new Set(targets.map(t => t.id)).size !== targets.length) throw new Error("duplicate_target");
    return targets;
  } catch { throw new Error("cloud_configuration_invalid"); }
}

export function cloudTargetReady(target: CloudEnvironment, env: NodeJS.ProcessEnv, now: number): boolean {
  if (target.provider === "colab") return false; // Owner-specific readiness is shown by the attended entry point.
  const age = target.verifiedAt ? now - Date.parse(target.verifiedAt) : 0;
  const storage = target.storage, drive = target.drive;
  const driveReady = !!drive && !!env[drive.clientIdEnv] && !!env[drive.clientSecretEnv] && !!env[drive.refreshTokenEnv];
  const transferReady = target.transferMode === "git" ? !!target.git && !!env[target.git.accessHeaderEnv] && (!drive || driveReady)
    : target.transferMode === "drive" ? driveReady
      : !!storage && !!env[storage.accessKeyEnv] && !!env[storage.secretKeyEnv]
        && (!storage.sessionTokenEnv || !!env[storage.sessionTokenEnv]);
  return age >= 0 && age <= 24 * 60 * 60 * 1000 && transferReady
    && (target.provider !== "claude-cloud" || !!env[target.claudeTokenEnv!]);
}
