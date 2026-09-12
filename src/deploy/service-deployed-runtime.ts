import type Database from "better-sqlite3";
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { matchProjectRow } from "./service-code-match.js";
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
  subsidiaries: Pick<SubsidiaryRepo, "list" | "listDeployProjects" | "listDeployNotify">;
  excubitor: Pick<ExcubitorClient, "findService">;
  hqTargets: () => Array<{ kind: "discord" | "slack" | "cc-channel"; target: string }>;
}): DeploymentLookup {
  return {
    // 本社宛先は project 行の有無に関わらず配る (handleServiceDeployment が行無しのとき参照する)。
    hqTargets: () => input.hqTargets(),
    findProject: (code) => {
      // Excubitor のサービスコード (`revisor` / `memoria-server`) は Cc の project code (`Rv`) と
      // 一致しないので、 完全一致 → project 名 → repo_origin 末尾 の順で引く。
      const row = input.projects.findByCode(code) ?? matchProjectRow(input.projects.list(), code);
      if (!row) return null;
      const subsidiaries = input.subsidiaries.list().flatMap((subsidiary) => input.subsidiaries.listDeployNotify(subsidiary.id)
        .filter((target) => target.enabled === 1)
        .map((target) => ({
          subsidiaryId: subsidiary.id,
          enabled: subsidiary.enabled === 1,
          // 通知対象 project (関係 project ではない)。 未設定の子会社には何も届かない。
          projects: input.subsidiaries.listDeployProjects(subsidiary.id),
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
  /** 子会社 Bot 未設定時に使う本社 Bot のトークン (未設定なら null)。 */
  hqBotToken?: () => string | null;
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
      const token = resolveSubsidiaryBotToken({ encryptedToken, decrypt: input.decryptBotToken, hqToken: input.hqBotToken });
      if (!token) throw new Error("subsidiary deployment channel has no bot credential (subsidiary token unset and HQ bot token unavailable)");
      const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      if (!response.ok) throw new Error(`subsidiary deployment channel rejected request (${response.status})`);
    },
  };
}

/**
 * 子会社チャンネルへ投稿する Bot トークン。 子会社 Bot が設定されていればそれ、
 * 無ければ本社 Bot (Cc 本体) で代替する。 どちらも無ければ null (配送失敗として記録)。
 */
export function resolveSubsidiaryBotToken(input: {
  encryptedToken: string | null | undefined;
  decrypt: (encrypted: string) => string;
  hqToken?: () => string | null;
}): string | null {
  if (input.encryptedToken) {
    try {
      const token = input.decrypt(input.encryptedToken);
      if (token) return token;
    } catch {
      // 復号できない子会社トークンは本社 Bot へ倒す (投稿できないよりは届く方を選ぶ)。
    }
  }
  return input.hqToken?.() ?? null;
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
