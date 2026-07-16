import type { SlackSessionIndexEntry } from "../platform/chat-read-model.js";

export const SESSIONS_CANVAS_KEY = "sessions_canvas_id";
export const SESSIONS_CANVAS_TITLE = "Cc Sessions";

interface CanvasDocument {
  type: "markdown";
  markdown: string;
}

interface CanvasReplaceChange {
  operation: "replace";
  document_content: CanvasDocument;
}

export interface SessionsCanvasClient {
  canvases: {
    edit(args: { canvas_id: string; changes: [CanvasReplaceChange] }): Promise<{ ok?: boolean }>;
  };
  conversations: {
    canvases: {
      create(args: {
        channel_id: string;
        title: string;
        document_content: CanvasDocument;
      }): Promise<{ canvas_id?: string; ok?: boolean }>;
    };
  };
}

export interface SessionsCanvasDeps {
  client: SessionsCanvasClient;
  hubChannelId: string;
  getSessions: () => SlackSessionIndexEntry[];
  channelForSession: (sessionId: string) => string | null;
  configGet: (key: string) => string | null;
  configSet: (key: string, value: string) => void;
  configDelete: (key: string) => void;
  debounceMs?: number;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export function renderSessionsCanvas(
  sessions: SlackSessionIndexEntry[],
  channelForSession: (sessionId: string) => string | null,
): string {
  const sections: Record<"Active" | "Waiting" | "Recently completed" | "Failed / abandoned", SlackSessionIndexEntry[]> = {
    Active: [],
    Waiting: [],
    "Recently completed": [],
    "Failed / abandoned": [],
  };
  for (const session of sessions) {
    if (!channelForSession(session.sessionId)) continue;
    if (session.status === "active" && session.waiting) sections.Waiting.push(session);
    else if (session.status === "active") sections.Active.push(session);
    else if (session.status === "ended") sections["Recently completed"].push(session);
    else if (session.status === "lost" || session.status === "abandoned") sections["Failed / abandoned"].push(session);
  }
  const output = ["# Cc Sessions"];
  for (const [heading, rows] of Object.entries(sections)) {
    output.push("", `## ${heading}`);
    const sorted = [...rows].sort((left, right) => right.updatedAt - left.updatedAt);
    const limited = heading === "Recently completed" ? sorted.slice(0, 20) : sorted;
    if (limited.length === 0) {
      output.push("_None_");
      continue;
    }
    for (const row of limited) {
      const channelId = channelForSession(row.sessionId)!;
      const persona = oneLine(row.persona || "-");
      const task = oneLine(row.currentTask || "-");
      const updated = new Date(row.updatedAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      output.push(
        `- <#${channelId}> · \`${row.sessionId.slice(0, 8)}\` · ${persona} / ${oneLine(row.provider)} · ${task} · ${updated}`,
      );
    }
  }
  return output.join("\n");
}

export class SessionsCanvasController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: SessionsCanvasDeps) {}

  schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueRefresh();
    }, this.deps.debounceMs ?? 250);
    this.timer.unref?.();
  }

  refreshNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.enqueueRefresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.queue;
  }

  private enqueueRefresh(): Promise<void> {
    this.queue = this.queue.then(() => this.apply()).catch((error) => {
      this.deps.log?.warn(`Sessions Canvas refresh failed: ${(error as Error).message}`);
    });
    return this.queue;
  }

  private async apply(): Promise<void> {
    const markdown = renderSessionsCanvas(this.deps.getSessions(), this.deps.channelForSession);
    const stored = this.deps.configGet(SESSIONS_CANVAS_KEY);
    if (stored) {
      try {
        await this.deps.client.canvases.edit({
          canvas_id: stored,
          changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
        });
        return;
      } catch (error) {
        this.deps.log?.warn(`Sessions Canvas edit failed (id=${stored}); recreate: ${(error as Error).message}`);
        this.deps.configDelete(SESSIONS_CANVAS_KEY);
      }
    }
    const created = await this.deps.client.conversations.canvases.create({
      channel_id: this.deps.hubChannelId,
      title: SESSIONS_CANVAS_TITLE,
      document_content: { type: "markdown", markdown },
    });
    if (!created.canvas_id) throw new Error("Sessions Canvas create returned no canvas_id");
    this.deps.configSet(SESSIONS_CANVAS_KEY, created.canvas_id);
    this.deps.log?.info(`Sessions Canvas created id=${created.canvas_id} channel=${this.deps.hubChannelId}`);
  }
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}
