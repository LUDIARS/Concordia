/**
 * 中央チャット レスポンダ.
 *
 * 「persona X の声で channel に 1 発話を出す」 を 1 箇所に集約する.
 * 旧来は (a) rule engine が claude CLI で post を生成し、 (b) dispatcher が
 * 各セッションのタスクキューに chat task を積んで **セッション側エージェント (Opus)**
 * に喋らせていた. これを廃し、 発話は全てここで中央 Haiku 描画 (render.ts) し、
 * Concordia 自身が persona 代理で投稿する.
 *
 * 投稿後は dispatcher.onChatPosted を呼んで peer 返信をファンアウトするが、
 * reply_depth 上限で連鎖の暴走 (= Haiku コスト暴走) を止める.
 */

import type { ChatChannel, ChatRepo } from "../db/chat-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { isActionableSuggestion } from "../chat-actionable.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import {
  renderChat,
  type ChatIntent,
  type PersonaVoice,
  type RenderConfig,
  type RenderContext,
} from "./render.js";

const log = createChildLogger("chat-responder");

/** 返信連鎖の最大深さ. depth 0 (起点) → 1 (返信) → 2 で打ち止め. */
export const MAX_REPLY_DEPTH = 2;

/** rule engine 等が「司会」 として喋るときの固定 persona. */
export const COORDINATOR_VOICE: PersonaVoice = {
  name: "concordia",
  display_name: "concordia",
  description: "セッション群を見守る中立の司会. 事実を軽く共有し、 会話の口火を切る.",
  traits: ["中立", "簡潔", "場をつなぐ"],
  speech_style: "短く淡々と. 煽らず、 事実ベースで 1 文.",
};

export interface SpeakRequest {
  channel: ChatChannel;
  intent: ChatIntent;
  /** 喋り手のセッション (persona を引く). null / 省略で司会 (COORDINATOR_VOICE). */
  sessionId?: string | null;
  /** 描画素材. */
  context: RenderContext;
  /** 返信元 message id. */
  inReplyTo?: number | null;
  /** 返信連鎖の深さ (起点 0). */
  replyDepth?: number;
  /** chat metadata に畳む追加情報. */
  metadata?: Record<string, unknown>;
}

export interface ResponderDeps {
  chat: ChatRepo;
  personas: PersonasRepo;
  sessions: SessionsRepo;
  renderConfig: () => RenderConfig;
  /** chat 全停止スイッチ. true で speak は何もしない. */
  isChatMuted?: () => boolean;
  /** コスト予算超過スイッチ. true で speak は何もしない. */
  isCostBlocked?: () => boolean;
}

/** dispatcher との相互参照を遅延束縛するための最小 interface. */
export interface ReplyFanout {
  onChatPosted(
    message: {
      id: number;
      channel: ChatChannel;
      session_id: string | null;
      text: string;
      author_label: string;
      is_actionable: boolean;
    },
    replyDepth: number,
  ): void;
}

export class ChatResponder {
  private fanout: ReplyFanout | null = null;

  constructor(private readonly deps: ResponderDeps) {}

  /** dispatcher を後付けで束縛する (循環参照回避). */
  attachFanout(fanout: ReplyFanout): void {
    this.fanout = fanout;
  }

  /** セッションに割当たった persona の声色を引く. 未割当なら role から最小構成. */
  voiceForSession(sessionId: string | null | undefined): PersonaVoice {
    if (!sessionId) return COORDINATOR_VOICE;
    const assignment = this.deps.personas.findActiveBySession(sessionId);
    if (assignment) {
      const p = this.deps.personas.find(assignment.persona_id);
      if (p) {
        return {
          name: p.name,
          display_name: p.display_name || p.name,
          description: p.description,
          traits: parseTraits(p.traits),
          speech_style: p.speech_style,
        };
      }
    }
    const role = this.roleForSession(sessionId);
    return { name: role, display_name: role };
  }

  private roleForSession(sessionId: string): string {
    const s = this.deps.sessions.findSession(sessionId);
    if (s && s.metadata) {
      try {
        const m = JSON.parse(s.metadata) as { role_label?: string };
        if (typeof m.role_label === "string" && m.role_label) return m.role_label;
      } catch {
        /* ignore */
      }
    }
    return "雑用係";
  }

  /**
   * persona 代理で 1 発話を描画 → 投稿する. 描画不能 (失敗 / 空) なら何もしない.
   * 投稿できたら dispatcher へ渡して peer 返信をファンアウトする (depth 上限まで).
   */
  async speak(req: SpeakRequest): Promise<void> {
    if (this.deps.isChatMuted?.() || this.deps.isCostBlocked?.()) return;
    const depth = req.replyDepth ?? 0;

    const persona = this.voiceForSession(req.sessionId);
    let text: string | null = null;
    try {
      text = await renderChat(
        { persona, channel: req.channel, intent: req.intent, context: req.context },
        this.deps.renderConfig(),
      );
    } catch (err) {
      log.warn({ err: (err as Error).message, intent: req.intent }, "render threw");
      return;
    }
    if (!text) return;

    const actionable = isActionableSuggestion(text);
    const metadata = JSON.stringify({
      ...(req.metadata ?? {}),
      via: "responder",
      intent: req.intent,
      reply_depth: depth,
      scope: "world",
    });

    const msg = this.deps.chat.insert({
      channel: req.channel,
      session_id: req.sessionId ?? null,
      author_label: persona.display_name || persona.name,
      text,
      in_reply_to: req.inReplyTo ?? null,
      is_actionable: actionable,
      metadata,
    });

    log.info(
      { message_id: msg.id, channel: msg.channel, author_label: msg.author_label, intent: req.intent, depth },
      "responder posted",
    );

    eventBus.emit({
      type: "chat.posted",
      message_id: msg.id,
      channel: msg.channel,
      author_label: msg.author_label,
      session_id: msg.session_id,
      ts: msg.ts,
      is_actionable: actionable,
      scope: "world",
    });

    // peer 返信ファンアウト. depth 上限で連鎖を止める.
    this.fanout?.onChatPosted(
      {
        id: msg.id,
        channel: msg.channel,
        session_id: msg.session_id,
        text: msg.text,
        author_label: msg.author_label,
        is_actionable: actionable,
      },
      depth,
    );
  }
}

function parseTraits(raw: string): string[] {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
