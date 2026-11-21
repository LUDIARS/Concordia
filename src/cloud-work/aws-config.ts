import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AwsId } from "./aws-request.js";

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]+$/);
const Artifact = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/).refine(name => name !== "result.json");

const Binding = z.object({
  repoPath: z.string().min(1),
  subsidiaryId: z.string().nullable(),
  ownerId: z.string().min(1).max(150),
  organizationId: z.string().min(1).max(150),
  targetId: AwsId,
  runner: AwsId,
  destination: AwsId,
  maxSeconds: z.number().int().positive().max(604800),
  usageUnitsPerMinute: z.number().positive().finite(),
  maxUsageUnits: z.number().positive().finite(),
  drive: z.object({
    folderId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
    clientIdEnv: EnvName, clientSecretEnv: EnvName, refreshTokenEnv: EnvName,
    sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    expectedNames: z.array(Artifact).min(1).max(20).refine(names => new Set(names).size === names.length),
    maxArtifactBytes: z.number().int().safe().positive(),
  }).strict().optional(),
}).strict();
export type AwsBinding = z.infer<typeof Binding>;
export type AwsDriveBinding = NonNullable<AwsBinding["drive"]>;

export async function readAwsBindings(path: string | undefined): Promise<AwsBinding[]> {
  if (!path) return [];
  try {
    const raw = await readFile(path);
    if (raw.length > 256_000) throw new Error("configuration too large");
    const bindings = z.array(Binding).max(50).parse(JSON.parse(raw.toString("utf8")));
    const keys = new Set(bindings.map(b => JSON.stringify([b.repoPath, b.subsidiaryId, b.targetId, b.runner])));
    if (keys.size !== bindings.length) throw new Error("duplicate AWS binding");
    return bindings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("cloud_configuration_invalid");
  }
}
