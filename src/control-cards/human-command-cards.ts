/**
 * 人間依頼 (human-command) のカード (実装メモ 6)。DB に記録が無いので、AI の発言 (session.message) の
 * マーカーからカードを作る。source_key = `<session_message_id>:<index>`。このカードだけはカードが正本で、
 * 人間の「済み」(Web / Discord / 人間依頼の OK ボタン) かセッション終了で閉じる。
 *
 * @implements spec/feature/control-cards.md — 人間依頼のカード
 */
import { clipText, CARD_SUMMARY_MAX_CHARS, type ControlCard } from "./card-domain.js";
import { notify, type CardChange } from "./card-sync.js";
import type { ControlCardsRepository } from "./repository.js";

/** 発言本文から人間依頼を取り出す (実体は src/discord/human-command-marker.ts の parseHumanCommandRequests)。 */
export type HumanCommandParser = (text: string) => Array<{ description: string; command: string }>;

export interface HumanCommandCardPorts {
  repo: ControlCardsRepository;
  /** 人間依頼チャンネルと同じ解釈を使い、発言内の順番 (index) を揃える。 */
  parse: HumanCommandParser;
  now: () => number;
  id: () => string;
  projectOf: (sessionId: string) => string | null;
  webUrl: (path: string) => string;
  onChange?: (change: CardChange) => void;
  log: { warn(message: string): void };
}

export function humanCommandSourceKey(messageId: number, index: number): string {
  return `${messageId}:${index}`;
}

export function createHumanCommandCards(ports: HumanCommandCardPorts) {
  return {
    /** AI の発言 1 件からカードを作る。同じ発言の更新の再配送では作り直さない (同一性は出所キー)。 */
    onSessionMessage(message: { sessionId: string; messageId: number; authorType: string; content: string }): ControlCard[] {
      if (message.authorType !== "assistant") return [];
      const requests = ports.parse(message.content);
      const opened: ControlCard[] = [];
      requests.forEach((request, index) => {
        const key = humanCommandSourceKey(message.messageId, index);
        if (ports.repo.findBySource("human-command", key)) return;
        const card = ports.repo.open(ports.id(), {
          source_kind: "human-command", source_key: key,
          summary: clipText(`人間依頼: ${request.description || "コマンドの実行"} — ${request.command}`, CARD_SUMMARY_MAX_CHARS),
          raised_at: ports.now(), session_id: message.sessionId, project: ports.projectOf(message.sessionId),
          link: ports.webUrl(`/sessions/${message.sessionId}`),
        }, ports.now());
        opened.push(card);
        notify(ports, { kind: "opened", card });
      });
      return opened;
    },

    /** 人間依頼を済みにする。人間依頼以外のカードは閉じない (CC-V5-INV-02)。 */
    markDone(card: ControlCard, actor: string): ControlCard | null {
      if (card.source_kind !== "human-command" || card.state !== "open") return null;
      if (!ports.repo.close(card.id, `done_by:${clipText(actor, 100)}`, ports.now())) return null;
      const closed = ports.repo.find(card.id)!;
      notify(ports, { kind: "closed", card: closed });
      return closed;
    },
  };
}

export type HumanCommandCards = ReturnType<typeof createHumanCommandCards>;
