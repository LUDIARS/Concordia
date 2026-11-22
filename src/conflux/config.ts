import { isAbsolute } from "node:path";
import { z } from "zod";
import { INSTRUCTION_AGENTS } from "../agent-instructions/instruction-policy.js";

const text = z.string().min(1).max(256);
const snowflake = z.string().regex(/^\d{5,32}$/);
const slackChannel = z.string().regex(/^[CG][A-Z0-9]{5,31}$/);
const destinations = z.array(z.discriminatedUnion("kind", [
  z.object({ project: text, kind: z.literal("subsidiary"), address: z.object({ subsidiary_id: text }).strict() }),
  z.object({ project: text, kind: z.literal("discord"), address: z.object({ guild_id: snowflake, channel_id: snowflake }).strict(), subsidiaryId: text.optional() }),
  z.object({ project: text, kind: z.literal("slack"), address: z.object({ channel_id: slackChannel }).strict() }),
]));
const actors = z.array(z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  platform: z.enum(["discord", "slack"]),
  userId: text,
  organizationId: text,
})).refine((entries) => new Set(entries.map((entry) => entry.sha256)).size === entries.length);
const integrations = z.array(z.object({
  prId: text,
  projectCode: text,
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  decisionId: text,
  commit: z.string().regex(/^[a-f0-9]{7,40}$/),
})).max(100);
const builds = z.record(z.string().refine(isAbsolute));
const mergeReturns = z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), z.object({
  platforms: z.array(z.string().min(1).max(100)).min(1).max(32),
  agent: z.enum(INSTRUCTION_AGENTS).default("muse"),
  // false: the agent fetches and builds the merge commit itself; Concordia queues no Conflux build.
  build: z.boolean().default(true),
}).strict());

export function readConfluxConfig(env: NodeJS.ProcessEnv) {
  const parsed = <T>(schema: z.ZodType<T>, key: string, fallback: T): T => {
    const value = env[key]?.trim();
    if (!value) return fallback;
    try { return schema.parse(JSON.parse(value)); }
    catch { throw new Error(`Invalid ${key}`); }
  };
  const hookBase = env.CONFLUX_URL?.trim();
  const hookToken = env.CONFLUX_HOOK_TOKEN?.trim();
  const url = hookBase ? new URL(hookBase) : undefined;
  if (url && (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid CONFLUX_URL");
  }
  return {
    destinations: parsed(destinations, "CONCORDIA_CONFLUX_DESTINATIONS", []),
    actors: parsed(actors, "CONCORDIA_CONFLUX_ACTORS", []),
    integrations: parsed(integrations, "CONCORDIA_CONFLUX_INTEGRATIONS", []),
    builds: parsed(builds, "CONCORDIA_CONFLUX_BUILD_RUNNERS", {}),
    mergeReturns: parsed(mergeReturns, "CONCORDIA_MERGE_PLAYTEST_RETURN", {}),
    hook: url && hookToken ? { base: url.href.replace(/\/+$/, ""), token: hookToken } : null,
  };
}

export type ConfluxConfig = ReturnType<typeof readConfluxConfig>;
