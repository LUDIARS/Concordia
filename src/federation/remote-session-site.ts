/**
 * 拠点側: 本社から届いた spawn / ingress を処理し、セッションの発言を本社スレッドへ返す
 * (連合 Phase 4: 本社からのセッション起動)。
 *
 * 拠点は Discord の Bot トークンを持たない。投稿はすべて連合リンクの egress 要求で
 * 本社に代行させ、本社は「その拠点に渡したスレッド」宛てだけを通す (runtime.ts)。
 *
 * @implements spec/feature/federation-link.md §本社からのセッション起動
 */
import { parseSiteEventPayload, type RemoteIngressPayload, type RemoteSpawnOptions, type RemoteSpawnPayload } from "./remote-session-payload.js";
import type { RemoteThreadRegistry } from "./remote-thread-registry.js";
import type { SessionMirrorStore } from "./session-mirror-store.js";
import type { FederationEgressQuestion } from "./protocol.js";

/** 本社へ送る発言の見た目 (通常セッションと同じ webhook 名・アイコン)。 */
export interface RemoteRelayIdentity {
  username: string;
  avatarUrl?: string;
}

export interface RemoteEgressRequest {
  guildId: string;
  channelId: string;
  text: string;
  username?: string;
  avatarUrl?: string;
  mentionRequester?: boolean;
  question?: FederationEgressQuestion;
}

/** 本社の質問カードで選ばれた回答を拠点の質問へ渡した結果。 */
export type RemoteAnswerResult = { ok: true } | { ok: false; error: string };

/** 本社からの返信を注入したときの inject source を覚えておく件数 (拠点の Discord 発言との区別に使う)。 */
const HQ_INJECT_SOURCE_LIMIT = 500;

/** 映した投稿の最初の本文。 */
export const SITE_MIRROR_STARTER = "拠点のフォーラムで起動したセッションを映しています。この投稿への返信はそのセッションに届きます。";

/** egress 本文の 1 通あたりの文字数 (Discord 2000 と protocol の 8000 に余白を残す)。 */
export const REMOTE_RELAY_CHUNK = 1800;

export interface RemoteSessionSiteDeps {
  registry: RemoteThreadRegistry;
  /** forum 起動と同じ依頼文を組み立てる (discord/ を import しないため注入)。 */
  buildPrompt(title: string, body: string, runtimeRules: readonly string[]): string;
  spawn(input: { guildId: string; channelId: string; authorId: string | null; prompt: string; options?: RemoteSpawnOptions }): Promise<{ ok: boolean; error?: string }>;
  /** そのスレッドから起動した稼働中セッション。無ければ null。 */
  findSessionByChannel(channelId: string): string | null;
  /** セッション metadata の起動元スレッド。無ければ null。 */
  channelOfSession(sessionId: string): string | null;
  inject(input: { sessionId: string; text: string; source: string }): void;
  requestEgress(input: RemoteEgressRequest): Promise<{ ok: boolean; error?: string }>;
  /** セッションの webhook 名・アイコン (SPEC-FED-SITE-FORUM-PARITY)。 未注入なら従来どおり本社の既定名で出る。 */
  identityOf?(sessionId: string): RemoteRelayIdentity | null;
  /** 拠点の表示名。 拠点の Discord で書かれた人の発言を本社へ映すときの名前に添える。 */
  siteLabel?(): string;
  /** 本社の質問カードで選ばれた回答を拠点の質問へ渡す。 未注入なら選択肢名を返信として注入する。 */
  answerQuestion?(input: { sessionId: string; questionId: number; optionIndexes: number[] }): Promise<RemoteAnswerResult>;
  /** 本社で書かれた返信を拠点のセッション面 (拠点のフォーラム投稿) にも出す。 */
  echoToSiteSurface?(input: { sessionId: string; authorLabel: string; text: string }): void;
  /** 拠点のセッションを映す投稿 (SPEC-FED-SITE-SESSION-MIRROR)。 未注入なら映さない。 */
  mirror?: {
    store: SessionMirrorStore;
    /** 映す題名。 起動元スレッドを持たないセッションは null (映さない)。 */
    sourceOf(sessionId: string): { channelId: string; title: string } | null;
    isActive(sessionId: string): boolean;
    requestOpen(input: { sessionId: string; title: string; text: string }): Promise<{ ok: boolean; guildId?: string; channelId?: string; error?: string }>;
    now?: () => number;
  };
  log: { info(message: string): void; warn(message: string): void };
}

export interface RemoteSessionSite {
  handleEvent(payload: unknown): Promise<void>;
  /** canonical session.message (AI 発言) を本社スレッドへ返す。 */
  relaySessionMessage(input: { sessionId: string; authorType: string; content: string; authorPlatform?: string | null; authorLabel?: string | null; injectSource?: string | null }): Promise<void>;
  /** 拠点のセッションの質問を、 本社の投稿にボタン付きカードとして出す (SPEC-FED-SITE-FORUM-PARITY)。 */
  relayQuestion(input: { sessionId: string; question: FederationEgressQuestion }): Promise<void>;
  /**
   * 本社から起動したセッションか。 メンションは起動した側にだけ付けるため、 拠点の Discord では
   * このセッションの依頼者をメンションしない (本社の投稿で本社がメンションする)。
   */
  isHqLaunched(sessionId: string): boolean;
  /**
   * 拠点自身のフォーラムで起動したセッションを本社の Session フォーラムへ映す
   * (2026-10-11 neco「MELPOT側のフォーラムでspawnしていた。本社側でも投稿できるようにしてほしい」)。
   * 本社から渡されたスレッドで起動したセッションは、すでに本社に投稿があるので映さない。
   */
  mirrorSession(sessionId: string): Promise<void>;
}

export function splitForRelay(text: string, size = REMOTE_RELAY_CHUNK): string[] {
  const chars = Array.from(text.trim());
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(""));
  return chunks;
}

export function createRemoteSessionSite(deps: RemoteSessionSiteDeps): RemoteSessionSite {
  const mirrorInFlight = new Map<string, Promise<void>>();
  /** 本社からの返信を注入したときの source。 拠点の Discord で書かれた発言だけを本社へ映すために区別する。 */
  const hqInjectSources = new Set<string>();
  const rememberHqInject = (source: string): void => {
    hqInjectSources.add(source);
    if (hqInjectSources.size > HQ_INJECT_SOURCE_LIMIT) hqInjectSources.delete(hqInjectSources.values().next().value!);
  };
  const send = async (request: RemoteEgressRequest): Promise<void> => {
    const result = await deps.requestEgress(request).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (!result.ok) deps.log.warn(`remote session egress failed channel=${request.channelId}: ${result.error ?? "unknown"}`);
  };
  const notify = (guildId: string, channelId: string, text: string): Promise<void> => send({ guildId, channelId, text });
  const identityFields = (sessionId: string): Pick<RemoteEgressRequest, "username" | "avatarUrl"> => {
    const identity = deps.identityOf?.(sessionId) ?? null;
    if (!identity) return {};
    return { username: identity.username, ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}) };
  };

  /** 発言を返す本社の投稿。 本社から起動したスレッド → 映した投稿の順に引く。 */
  const relayTargetOf = (sessionId: string): { guildId: string; channelId: string } | null => {
    const channelId = deps.channelOfSession(sessionId);
    const entry = channelId ? deps.registry.find(channelId) : null;
    if (channelId && entry) return { guildId: entry.guildId, channelId };
    const mirrored = deps.mirror?.store.find(sessionId);
    return mirrored ? { guildId: mirrored.guildId, channelId: mirrored.channelId } : null;
  };

  /** 映した投稿への返信を受けるセッション (稼働中だけ)。 */
  const mirroredSessionOf = (channelId: string): string | null => {
    const sessionId = deps.mirror?.store.keyOfChannel(channelId) ?? null;
    return sessionId && deps.mirror?.isActive(sessionId) ? sessionId : null;
  };

  const spawn = async (payload: RemoteSpawnPayload): Promise<void> => {
    // 再接続直後の再送では起動し直さない (at-least-once)。
    if (!deps.registry.record(payload.channel_id, { guildId: payload.guild_id, siteId: null, at: payload.ts * 1000 })) {
      deps.log.info(`remote spawn duplicate ignored channel=${payload.channel_id}`);
      return;
    }
    const result = await deps.spawn({
      guildId: payload.guild_id,
      channelId: payload.channel_id,
      authorId: payload.author_id,
      prompt: deps.buildPrompt(payload.title, payload.body, payload.runtime_rules),
      ...(payload.options ? { options: payload.options } : {}),
    }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (!result.ok) {
      deps.log.warn(`remote spawn failed channel=${payload.channel_id}: ${result.error ?? "unknown"}`);
      // 台帳に残すと、本社からの再送が「再送」扱いで捨てられ、起動し直せなくなる。
      deps.registry.forget(payload.channel_id);
      await notify(payload.guild_id, payload.channel_id, "拠点でのセッション起動に失敗しました。拠点の Cc のログを確認してください。");
      return;
    }
    await notify(payload.guild_id, payload.channel_id, "拠点でセッションを起動しました。このスレッドへの返信はそのセッションに届きます。");
  };

  const ingress = async (payload: RemoteIngressPayload): Promise<void> => {
    if (!deps.registry.find(payload.channel_id)) return; // この拠点で起動したスレッドだけを扱う。
    // forum の最初の投稿 (message id == thread id) は spawn 側が本文として渡している。
    if (payload.message_id === payload.channel_id) return;
    const sessionId = mirroredSessionOf(payload.channel_id) ?? deps.findSessionByChannel(payload.channel_id);
    if (!sessionId) {
      await notify(payload.guild_id, payload.channel_id, "拠点のセッションがまだ準備中か、終了しています。少し待ってから送り直してください。");
      return;
    }
    if (payload.answer && deps.answerQuestion) {
      const answered = await deps.answerQuestion({ sessionId, questionId: payload.answer.question_id, optionIndexes: payload.answer.option_indexes })
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
      if (!answered.ok) {
        deps.log.warn(`remote question answer failed session=${sessionId} question=${payload.answer.question_id}: ${answered.error}`);
        await notify(payload.guild_id, payload.channel_id, `拠点で回答を受け付けられませんでした (${answered.error})。すでに回答済みか、質問が閉じています。`);
      }
      return;
    }
    const source = `discord:${payload.author_id}:${payload.message_id}`;
    rememberHqInject(source);
    deps.inject({ sessionId, text: payload.text, source });
    // 本社で書かれた返信を拠点のフォーラム投稿にも残し、 両方で同じ会話に見せる。
    deps.echoToSiteSurface?.({ sessionId, authorLabel: payload.author_label, text: payload.text });
  };

  return {
    async handleEvent(raw) {
      const payload = parseSiteEventPayload(raw);
      if (!payload) return;
      if (payload.type === "spawn") await spawn(payload);
      else await ingress(payload);
    },
    async relaySessionMessage(message) {
      const target = relayTargetOf(message.sessionId);
      if (!target) return;
      if (message.authorType === "assistant") {
        const identity = identityFields(message.sessionId);
        for (const chunk of splitForRelay(message.content)) await send({ ...target, text: chunk, ...identity });
        return;
      }
      // 拠点の Discord で人が書いた発言も本社へ映す (本社から届いた返信の写しは除く)。
      if (message.authorType !== "user" || message.authorPlatform !== "discord") return;
      if (!message.injectSource || hqInjectSources.has(message.injectSource)) return;
      const label = message.authorLabel?.trim() || "拠点の利用者";
      const site = deps.siteLabel?.().trim();
      const username = Array.from(site ? `${label} (${site})` : label).slice(0, 80).join("");
      for (const chunk of splitForRelay(message.content)) await send({ ...target, text: chunk, username });
    },
    async relayQuestion({ sessionId, question }) {
      const target = relayTargetOf(sessionId);
      if (!target) return;
      await send({ ...target, text: question.prompt, ...identityFields(sessionId), mentionRequester: true, question });
    },
    isHqLaunched(sessionId) {
      const channelId = deps.channelOfSession(sessionId);
      return Boolean(channelId && deps.registry.find(channelId));
    },
    async mirrorSession(sessionId) {
      const mirror = deps.mirror;
      if (!mirror || mirror.store.find(sessionId)) return;
      const pending = mirrorInFlight.get(sessionId);
      if (pending) return pending;
      const operation = (async (): Promise<void> => {
        const source = mirror.sourceOf(sessionId);
        // 本社から渡されたスレッドで起動したものは本社に投稿がある。
        if (!source || deps.registry.find(source.channelId)) return;
        const result = await mirror.requestOpen({ sessionId, title: source.title, text: SITE_MIRROR_STARTER })
          .catch((error: unknown) => ({ ok: false, error: String(error) } as { ok: boolean; guildId?: string; channelId?: string; error?: string }));
        if (!result.ok || !result.guildId || !result.channelId) {
          deps.log.warn(`site session mirror failed session=${sessionId}: ${result.error ?? "no post returned"}`);
          return;
        }
        const at = (mirror.now ?? Date.now)();
        mirror.store.record(sessionId, { guildId: result.guildId, channelId: result.channelId, at });
        // 本社からの返信 (ingress) をこの拠点の扱いとして受けるため、スレッド台帳にも載せる。
        deps.registry.record(result.channelId, { guildId: result.guildId, siteId: null, at });
        deps.log.info(`site session mirrored session=${sessionId} channel=${result.channelId}`);
      })();
      mirrorInFlight.set(sessionId, operation);
      try {
        await operation;
      } finally {
        if (mirrorInFlight.get(sessionId) === operation) mirrorInFlight.delete(sessionId);
      }
    },
  };
}
