import { createHash } from "node:crypto";
import type {
  SlackSessionChannelRow,
  SlackSessionChannelsRepo,
} from "./session-channels-repo.js";

const MAX_CHANNEL_NAME = 80;
const MAX_TOPIC = 250;
const MANAGED_PURPOSE_PREFIX = "Concordia managed session channel. Session ID: ";

export interface SlackSessionChannelHeader {
  text: string;
  blocks?: unknown[];
  username?: string;
}

export interface SlackSessionChannelDescription {
  title: string | null;
  topic: string;
  header: SlackSessionChannelHeader;
}

interface SlackChannelSummary {
  id?: string;
  name?: string;
  purpose?: { value?: string };
}

export interface SlackSessionProvisioningClient {
  conversations: {
    create(args: { name: string; is_private: false }): Promise<{ channel?: SlackChannelSummary }>;
    list(args: {
      types: "public_channel";
      exclude_archived: boolean;
      limit: number;
      cursor?: string;
    }): Promise<{ channels?: SlackChannelSummary[]; response_metadata?: { next_cursor?: string } }>;
    setTopic(args: { channel: string; topic: string }): Promise<unknown>;
    setPurpose(args: { channel: string; purpose: string }): Promise<unknown>;
  };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      blocks?: unknown;
      username?: string;
    }): Promise<{ ts?: string }>;
  };
}

export interface SlackSessionChannelProvisionerDeps {
  repo: SlackSessionChannelsRepo;
  client: SlackSessionProvisioningClient;
  describeSession: (sessionId: string) => SlackSessionChannelDescription;
  now?: () => number;
  log?: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void };
}

/** Slack-compatible deterministic channel-name candidates, in collision retry order. */
export function buildSessionChannelNames(sessionId: string, title: string | null): string[] {
  const normalizedId = asciiSegment(sessionId) || "session";
  const slug = asciiSegment(title ?? "") || "session";
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
  const candidates = [
    buildName(normalizedId.slice(0, 8), slug),
    buildName(normalizedId.slice(0, 12), slug),
    buildName(`${normalizedId.slice(0, 12)}-${hash}`, slug),
  ];
  return [...new Set(candidates)];
}

export function buildSessionChannelPurpose(sessionId: string): string {
  return `${MANAGED_PURPOSE_PREFIX}${sessionId}`.slice(0, MAX_TOPIC);
}

export function slackApiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const row = error as { code?: unknown; data?: { error?: unknown } };
  if (typeof row.data?.error === "string") return row.data.error;
  return typeof row.code === "string" ? row.code : null;
}

export class SlackSessionChannelProvisioner {
  private readonly inFlight = new Map<string, Promise<SlackSessionChannelRow>>();
  private readonly unpersistedChannels = new Map<string, SlackSessionChannelRow>();
  private readonly unpersistedHeaders = new Map<string, string>();

  constructor(private readonly deps: SlackSessionChannelProvisionerDeps) {}

  ensure(sessionId: string): Promise<SlackSessionChannelRow> {
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const existing = this.deps.repo.findBySessionId(sessionId);
    const task = (existing ? this.ensureHeader(existing) : this.provision(sessionId))
      .finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, task);
    return task;
  }

  async refreshMetadata(sessionId: string, topic?: string): Promise<void> {
    const row = this.deps.repo.findBySessionId(sessionId);
    if (!row) return;
    const description = this.deps.describeSession(sessionId);
    await this.setMetadata(row.channel_id, sessionId, topic ?? description.topic);
  }

  private async provision(sessionId: string): Promise<SlackSessionChannelRow> {
    const unpersisted = this.unpersistedChannels.get(sessionId);
    if (unpersisted) {
      this.persistCreatedChannel(unpersisted);
      this.unpersistedChannels.delete(sessionId);
      return this.ensureHeader(unpersisted);
    }

    const description = this.deps.describeSession(sessionId);
    for (const name of buildSessionChannelNames(sessionId, description.title)) {
      let channel: SlackChannelSummary | null = null;
      try {
        const created = await this.deps.client.conversations.create({ name, is_private: false });
        channel = created.channel ?? null;
      } catch (error) {
        const code = slackApiErrorCode(error);
        if (code === "name_taken") {
          channel = await this.findOwnedChannel(name, sessionId);
          if (!channel) continue;
        } else {
          if (code === "missing_scope" || code === "restricted_action") {
            this.deps.log?.error(
              `Slack session channel provisioning requires channels:manage (${code}) session=${sessionId}`,
            );
          }
          throw error;
        }
      }
      const channelId = channel?.id;
      if (!channelId) throw new Error(`Slack conversations.create returned no channel id session=${sessionId}`);
      const row: SlackSessionChannelRow = {
        session_id: sessionId,
        channel_id: channelId,
        channel_name: channel?.name ?? name,
        header_ts: null,
        created_at: this.deps.now?.() ?? Math.floor(Date.now() / 1000),
        archive_due_at: null,
        archived_at: null,
      };
      await this.setMetadata(channelId, sessionId, description.topic);
      try {
        this.persistCreatedChannel(row);
      } catch (error) {
        this.unpersistedChannels.set(sessionId, row);
        this.deps.log?.error(
          `Slack channel created but mapping persistence failed session=${sessionId} channel=${channelId}: ${(error as Error).message}`,
        );
        throw error;
      }
      this.deps.log?.info(`Slack session channel created session=${sessionId} channel=${channelId} name=${row.channel_name}`);
      return this.ensureHeader(row);
    }
    throw new Error(`Slack session channel names exhausted after name_taken session=${sessionId}`);
  }

  private persistCreatedChannel(row: SlackSessionChannelRow): void {
    this.deps.repo.upsert({
      session_id: row.session_id,
      channel_id: row.channel_id,
      channel_name: row.channel_name,
      header_ts: row.header_ts,
      created_at: row.created_at,
    });
  }

  private async ensureHeader(row: SlackSessionChannelRow): Promise<SlackSessionChannelRow> {
    if (row.header_ts) return row;
    const pendingHeader = this.unpersistedHeaders.get(row.session_id);
    if (pendingHeader) {
      this.deps.repo.setHeaderTs(row.session_id, pendingHeader);
      this.unpersistedHeaders.delete(row.session_id);
      return { ...row, header_ts: pendingHeader };
    }
    const header = this.deps.describeSession(row.session_id).header;
    const posted = await this.deps.client.chat.postMessage({
      channel: row.channel_id,
      text: header.text,
      ...(header.blocks ? { blocks: header.blocks as never } : {}),
      ...(header.username ? { username: header.username } : {}),
    });
    if (!posted.ts) throw new Error(`Slack session header returned no ts session=${row.session_id}`);
    try {
      this.deps.repo.setHeaderTs(row.session_id, posted.ts);
    } catch (error) {
      this.unpersistedHeaders.set(row.session_id, posted.ts);
      this.deps.log?.error(
        `Slack header posted but persistence failed session=${row.session_id} channel=${row.channel_id}: ${(error as Error).message}`,
      );
      throw error;
    }
    return { ...row, header_ts: posted.ts };
  }

  private async setMetadata(channelId: string, sessionId: string, topic: string): Promise<void> {
    const purpose = buildSessionChannelPurpose(sessionId);
    const settled = await Promise.allSettled([
      this.deps.client.conversations.setTopic({ channel: channelId, topic: topic.slice(0, MAX_TOPIC) }),
      this.deps.client.conversations.setPurpose({ channel: channelId, purpose }),
    ]);
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        const field = index === 0 ? "topic" : "purpose";
        this.deps.log?.warn(
          `Slack session channel ${field} update failed session=${sessionId} channel=${channelId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    });
  }

  private async findOwnedChannel(name: string, sessionId: string): Promise<SlackChannelSummary | null> {
    const purpose = buildSessionChannelPurpose(sessionId);
    let cursor: string | undefined;
    do {
      const page = await this.deps.client.conversations.list({
        types: "public_channel",
        exclude_archived: false,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      const match = page.channels?.find((channel) =>
        channel.name === name && channel.purpose?.value === purpose);
      if (match) return match;
      cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    } while (cursor);
    return null;
  }
}

function asciiSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function buildName(idPart: string, slug: string): string {
  const normalizedIdPart = idPart.replace(/-+$/g, "") || "session";
  const prefix = `cc-run-${normalizedIdPart}-`;
  const budget = Math.max(1, MAX_CHANNEL_NAME - prefix.length);
  return `${prefix}${slug.slice(0, budget).replace(/-+$/g, "") || "session"}`.slice(0, MAX_CHANNEL_NAME);
}
