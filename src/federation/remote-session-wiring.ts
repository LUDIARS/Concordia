/**
 * 拠点側 remote session の配線 (連合 Phase 4)。 Cc 本体 (sessions / eventBus / spawn API) と
 * remote-session-site.ts の純粋な処理をつなぐ。
 *
 * @implements spec/feature/federation-link.md §本社からのセッション起動
 */
import type { SettingsStore } from "../admin/settings-store.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { createRemoteSessionSite } from "./remote-session-site.js";
import { remoteSpawnRequestFields, withSiteDefaultCwd } from "./remote-session-payload.js";
import { createRemoteThreadRegistry } from "./remote-thread-registry.js";
import { createSessionMirrorStore, SITE_SESSION_MIRRORS_KEY } from "./session-mirror-store.js";

/** runtime.ts を import しないための最小ポート (module-runtime-composition-only)。 */
export interface RemoteSessionFederationPort {
  setSiteEventHandler(handler: ((payload: unknown) => void) | null): void;
  requestEgress(input: { guildId: string; channelId: string; text: string }): Promise<{ ok: boolean; error?: string }>;
  /** 拠点ロールで本社へ繋ぐ設定があるか (本社自身・連合なしでは映さない)。 */
  isSiteRole(): boolean;
  requestMirrorOpen(input: { sessionId: string; title: string; text: string }): Promise<{ ok: boolean; guildId?: string; channelId?: string; error?: string }>;
}

/** 映す投稿の題名。 作業内容 → プロジェクト → 作業フォルダ名の順。 */
export function mirrorTitleOf(session: { id: string; current_task?: string | null; repo_path?: string | null; metadata: string | null }): string {
  let project: unknown = null;
  try {
    project = (JSON.parse(session.metadata ?? "{}") as Record<string, unknown>).project;
  } catch {
    project = null;
  }
  const folder = session.repo_path?.split(/[\\/]/).filter(Boolean).pop();
  const base = session.current_task?.trim() || (typeof project === "string" && project.trim()) || folder || "セッション";
  return Array.from(base.replace(/\s+/g, " ")).slice(0, 90).join("");
}

export const SITE_REMOTE_THREADS_KEY = "federation.site.remote_threads";

export function readSourceChannel(metadata: string | null): string | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>).discord_source_channel_id;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

export function startRemoteSessionSite(input: {
  federation: RemoteSessionFederationPort;
  sessions: Pick<SessionsRepo, "findAllActive" | "findSession">;
  settings: Pick<SettingsStore, "get" | "set">;
  /** 自分自身の Cc (loopback)。 forum 起動と同じ /v1/admin/spawn-session を使う。 */
  concordiaUrl: string;
  buildPrompt(title: string, body: string, runtimeRules: readonly string[]): string;
  /** 起動場所の指定が無い依頼の cwd (拠点の主 workspace root)。 */
  workspaceRoot(): string;
  log: { info(message: string): void; warn(message: string): void };
}): { stop(): void } {
  const site = createRemoteSessionSite({
    registry: createRemoteThreadRegistry(input.settings, SITE_REMOTE_THREADS_KEY),
    buildPrompt: input.buildPrompt,
    async spawn(request) {
      const response = await fetch(`${input.concordiaUrl}/v1/admin/spawn-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...withSiteDefaultCwd(remoteSpawnRequestFields(request.options), input.workspaceRoot()),
          prompt: request.prompt,
          source_discord_guild_id: request.guildId,
          source_discord_channel_id: request.channelId,
          ...(request.authorId ? { requester_discord_user_id: request.authorId } : {}),
        }),
      });
      if (response.ok) return { ok: true };
      // 拒否理由をログに残す (HTTP status だけでは原因を追えない)。
      const reason = await response.json()
        .then((json) => (json as { error?: unknown }).error, () => undefined);
      return { ok: false, error: `spawn-session HTTP ${response.status}${typeof reason === "string" ? `: ${reason}` : ""}` };
    },
    findSessionByChannel: (channelId) =>
      input.sessions.findAllActive().find((session) => readSourceChannel(session.metadata) === channelId)?.id ?? null,
    channelOfSession: (sessionId) => readSourceChannel(input.sessions.findSession(sessionId)?.metadata ?? null),
    inject: ({ sessionId, text, source }) => {
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, ts: Math.floor(Date.now() / 1000) });
    },
    requestEgress: (request) => input.federation.requestEgress(request),
    mirror: {
      store: createSessionMirrorStore(input.settings, SITE_SESSION_MIRRORS_KEY),
      sourceOf: (sessionId) => {
        const session = input.sessions.findSession(sessionId);
        const channelId = readSourceChannel(session?.metadata ?? null);
        return session && channelId ? { channelId, title: mirrorTitleOf(session) } : null;
      },
      isActive: (sessionId) => input.sessions.findAllActive().some((session) => session.id === sessionId),
      requestOpen: (request) => input.federation.requestMirrorOpen(request),
    },
    log: input.log,
  });
  input.federation.setSiteEventHandler((payload) => {
    void site.handleEvent(payload).catch((error) => input.log.warn(`remote session event failed: ${String(error)}`));
  });
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.type === "session.started") {
      if (!input.federation.isSiteRole()) return;
      void site.mirrorSession(event.session_id)
        .catch((error) => input.log.warn(`remote session mirror failed: ${String(error)}`));
      return;
    }
    if (event.type !== "session.message" || event.op !== "create") return;
    void site.relaySessionMessage({
      sessionId: event.target_session_id,
      authorType: event.message.author_type,
      content: event.message.content,
    }).catch((error) => input.log.warn(`remote session relay failed: ${String(error)}`));
  });
  return {
    stop() {
      unsubscribe();
      input.federation.setSiteEventHandler(null);
    },
  };
}
