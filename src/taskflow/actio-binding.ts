import { z } from "zod";
import { posix, win32 } from "node:path";

const Binding = z.object({
  repoPath: z.string().min(1),
  project: z.string().min(1),
  projectId: z.string().min(1),
  ownerId: z.string().min(1).refine((id) => id !== "anonymous"),
  authMode: z.enum(["bearer", "loopback"]).optional(),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  subsidiaryId: z.string().min(1).nullable().default(null),
  teamId: z.string().min(1).nullable().default(null),
}).strict().superRefine((binding, ctx) => {
  const local = binding.authMode === "loopback";
  if (local ? binding.tokenEnv !== undefined || binding.ownerId !== "actio-local"
    || binding.teamId !== null || binding.subsidiaryId !== null : !binding.tokenEnv) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid Actio authentication binding" });
  }
});

export type ActioBinding = z.infer<typeof Binding>;
export type ActioAccess = Pick<ActioBinding, "ownerId" | "authMode" | "tokenEnv" | "teamId" | "subsidiaryId">;

/** Configuration errors must not expose tokens or raw configuration values. */
export function readActioBindings(env: NodeJS.ProcessEnv = process.env): ActioBinding[] {
  let value: unknown;
  try {
    if (env.CONCORDIA_ACTIO_TASK_BINDINGS !== undefined) {
      value = JSON.parse(env.CONCORDIA_ACTIO_TASK_BINDINGS);
    } else {
      if (env.EXCUBITOR_SERVICE_CONFIG_JSON === undefined) return [];
      const config = z.object({ actioTaskBindings: z.unknown().optional() })
        .parse(JSON.parse(env.EXCUBITOR_SERVICE_CONFIG_JSON));
      if (config.actioTaskBindings === undefined) return [];
      value = config.actioTaskBindings;
    }
  }
  catch { throw new Error("CONCORDIA_ACTIO_TASK_BINDINGS is required and must be JSON"); }
  const parsed = z.array(Binding).safeParse(value);
  if (!parsed.success) throw new Error("Invalid CONCORDIA_ACTIO_TASK_BINDINGS");
  const identities = new Set<string>();
  for (const binding of parsed.data) {
    if (!posix.isAbsolute(binding.repoPath) && !win32.isAbsolute(binding.repoPath)) {
      throw new Error("Actio binding repoPath must be absolute");
    }
    if (binding.subsidiaryId && !binding.teamId) throw new Error("Subsidiary Actio binding requires teamId");
    const identity = `${binding.projectId}\0${binding.ownerId}\0${binding.teamId ?? ""}`;
    if (identities.has(identity)) throw new Error("Duplicate Actio project ownership binding");
    identities.add(identity);
  }
  return parsed.data;
}

export function repositoryKey(value: string): string {
  const windows = win32.isAbsolute(value) && !posix.isAbsolute(value);
  const result = (windows ? win32.normalize(value) : posix.normalize(value.replace(/\\/g, "/")))
    .replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? result.toLowerCase() : result;
}
