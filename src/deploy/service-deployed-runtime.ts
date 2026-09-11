import type Database from "better-sqlite3";
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { resolveDeploymentTargets } from "./deployment-targets.js";
import type {
  DeploymentDelivery,
  DeploymentLedger,
  DeploymentLookup,
  RevisorChanges,
} from "./service-deployed.js";

/** Durable idempotency boundary: delivery is attempted at most once for one deployed hash. */
export class SqliteDeploymentLedger implements DeploymentLedger {
  constructor(private readonly db: Database.Database) {}

  claim(code: string, currentHash: string): boolean {
    return this.db.prepare(
      "INSERT INTO service_deployment_ledger(code, current_hash, received_at) VALUES (?, ?, ?) ON CONFLICT(code, current_hash) DO NOTHING",
    ).run(code, currentHash, Date.now()).changes === 1;
  }
}

export function createDeploymentLookup(input: {
  projects: ProjectCodesRepo;
  subsidiaries: Pick<SubsidiaryRepo, "list" | "listProjects" | "listDeployNotify">;
  excubitor: Pick<ExcubitorClient, "findService">;
  hqTargets: () => Array<{ kind: "discord" | "slack" | "cc-channel"; target: string }>;
}): DeploymentLookup {
  return {
    findProject: (code) => {
      const row = input.projects.findByCode(code);
      if (!row) return null;
      const subsidiaries = input.subsidiaries.list().flatMap((subsidiary) => input.subsidiaries.listDeployNotify(subsidiary.id)
        .filter((target) => target.enabled === 1)
        .map((target) => ({
          subsidiaryId: subsidiary.id,
          enabled: subsidiary.enabled === 1,
          projects: input.subsidiaries.listProjects(subsidiary.id),
          kind: target.kind,
          target: target.target,
          intakeChannelId: subsidiary.channel_id,
          botTokenEnc: subsidiary.bot_token_enc,
        })));
      return {
        repo_origin: row.repo_origin,
        deploy_notify: resolveDeploymentTargets({
          project: row.project,
          hq: input.hqTargets(),
          projectTargets: parseTargets(row.deploy_notify),
          workflow: row.revisor_workflow,
          subsidiaries,
        }).targets,
      };
    },
    changes: async (repository, from, to) => {
      const service = await input.excubitor.findService("revisor");
      const port = resolveServicePort(service);
      if (port === null) return null;
      const repositories = await fetch(`http://127.0.0.1:${port}/v1/repositories`, { headers: { "x-concordia-actor": "concordia" } });
      if (!repositories.ok) return null;
      const listed = await repositories.json() as { repositories?: Array<{ id?: string | number; repository?: string }> };
      const origin = normalizeRepoOrigin(repository).toLowerCase();
      const entry = listed.repositories?.find((row) => normalizeRepoOrigin(row.repository ?? "").toLowerCase() === origin);
      if (entry?.id === undefined || entry.id === null) return null;
      const url = new URL(`http://127.0.0.1:${port}/v1/repositories/${encodeURIComponent(String(entry.id))}/changes`);
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      const response = await fetch(url, { headers: { "x-concordia-actor": "concordia" } });
      if (!response.ok) return null;
      return await response.json() as RevisorChanges;
    },
  };
}

/** Webhook URLs are resolved by name at delivery time; project rows never contain secret URLs. */
export function createDeploymentDelivery(input: {
  webhookUrl: (name: string) => string | null;
  postCcChannel: (content: string) => Promise<void>;
  decryptBotToken: (encrypted: string) => string;
}): DeploymentDelivery {
  const post = async (name: string, content: string, slack: boolean) => {
    const url = input.webhookUrl(name);
    if (!url) throw new Error(`deployment webhook is not configured: ${name}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(slack ? { text: sanitizeSlackMentions(content) } : { content, allowed_mentions: { parse: [] } }),
    });
    if (!response.ok) throw new Error(`deployment webhook rejected request (${response.status})`);
  };
  return {
    discord: (name, content) => post(name, content, false),
    slack: (name, content) => post(name, content, true),
    ccChannel: input.postCcChannel,
    subsidiaryChannel: async (channelId, encryptedToken, content) => {
      const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${input.decryptBotToken(encryptedToken)}`, "content-type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      if (!response.ok) throw new Error(`subsidiary deployment channel rejected request (${response.status})`);
    },
  };
}

function parseTargets(value: string | undefined): Array<{ kind: "discord" | "slack" | "cc-channel"; target: string }> {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isTarget) : [];
  } catch { return []; }
}

function isTarget(value: unknown): value is { kind: "discord" | "slack" | "cc-channel"; target: string } {
  return !!value && typeof value === "object" && ["discord", "slack", "cc-channel"].includes((value as { kind?: string }).kind ?? "") && typeof (value as { target?: unknown }).target === "string";
}

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** Slack has no allowed_mentions; neutralise <!channel>/<!here>/<@id> that arrive in PR titles. */
function sanitizeSlackMentions(content: string): string {
  return content
    .replace(/<!(channel|here|everyone)>/gi, `<${ZERO_WIDTH_SPACE}!$1>`)
    .replace(/<@/g, `<${ZERO_WIDTH_SPACE}@`);
}
