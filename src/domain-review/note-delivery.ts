/**
 * src/domain-review/note-delivery.ts — ドメインへの指摘 (domain-note) を Anatomia の review-notes へ渡す手順。
 *
 * 1. 返信本文の先頭指定でドメインが決まれば、そのドメインへの指摘として送る。
 * 2. 決まらなければ台帳を `awaiting_choice` にし、選択肢を返す (Discord が選択ダイアログを出す)。
 * 3. 選ばれたら送る。「プロジェクト全体」は domainId 無しで送る。
 * 4. 結果 (proposalId / rejected の理由 / 送信失敗の理由) を台帳に残す。
 *
 * **無言で捨てない。** ドメイン一覧が取れない・送れないときは `failed` と理由を台帳に残し、
 * 同じ返信の再配送か `retry` で再試行できる。全体扱いで送ってしまうことはしない。
 * **二重送信しない。** 送信前に台帳を `sending` で占有し、終端 (`sent` / `rejected`) は再送しない。
 *
 * SRP: 手順の組み立てだけ。照合は note-domain.ts (純関数)、HTTP は anatomia-client.ts、
 * 永続化は domain-review-repo.ts、Discord の部品は chat-platform 側。
 *
 * @implements spec/feature/domain-review-discord.md §4.2
 */

import type {
  DomainReviewAnswerRow,
  DomainReviewNoteDeliveryRow,
  DomainReviewPostRow,
  DomainReviewRepo,
} from "../db/domain-review-repo.js";
import type { AnatomiaDomainClient } from "./anatomia-client.js";
import {
  buildNoteDomainChoices,
  parseNoteDomainChoice,
  resolveNoteDomain,
  type NoteDomainChoice,
} from "./note-domain.js";

/** `sending` のまま止まった行 (送信中の process 停止) を再試行で取り戻すまでの猶予。 */
export const NOTE_DELIVERY_STALE_MS = 5 * 60 * 1000;

export type NoteDeliveryOutcome =
  | { status: "sent"; answerId: number; domainId: string | null; proposalId: string }
  | { status: "rejected"; answerId: number; domainId: string | null; reason: string }
  | { status: "failed"; answerId: number; reason: string }
  | { status: "awaiting_choice"; answerId: number; choices: NoteDomainChoice[]; omitted: number }
  | { status: "sending"; answerId: number };

export type NoteChoiceResult =
  | { ok: true; outcome: NoteDeliveryOutcome }
  | { ok: false; reason: "answer_not_found" | "not_a_domain_note" | "forbidden" | "invalid_choice" };

export interface DomainReviewNoteDeliveryDeps {
  posts: DomainReviewRepo;
  anatomia: AnatomiaDomainClient;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** 返信者本人以外に選択を許す人 (既存の回答権限)。未配線は本人だけ。 */
  isReplyAuthorAllowed?: (platform: string, authorId: string) => boolean;
  now?: () => number;
}

interface SendTarget {
  domainId: string | null;
  projectWide: boolean;
  note: string;
  chosenBy: string | null;
}

/** Anatomia の reviewRef。台帳の answer id から引き戻せる値にする。 */
export function noteReviewRef(answerId: number): string {
  return `cc-domain-review-answer:${answerId}`;
}

export class DomainReviewNoteDelivery {
  constructor(private readonly deps: DomainReviewNoteDeliveryDeps) {}

  /**
   * 記録済みの domain-note を送る (返信の取り込み直後と、同じ返信の再配送時)。
   * 終端済みなら記録をそのまま返し、送信中なら待つ。
   */
  async deliver(post: DomainReviewPostRow, answer: DomainReviewAnswerRow): Promise<NoteDeliveryOutcome> {
    const current = this.deps.posts.findNoteDelivery(answer.id);
    if (current && (isTerminal(current) || this.isActiveSending(current))) return toOutcome(current);
    return this.resolveAndSend(post, answer);
  }

  /** 選択ダイアログの回答。返信者本人か回答権限のある人だけが選べる。 */
  async choose(input: {
    answerId: number;
    choice: string;
    platform: string;
    actorId: string;
  }): Promise<NoteChoiceResult> {
    const answer = this.deps.posts.findAnswerById(input.answerId);
    if (!answer) return { ok: false, reason: "answer_not_found" };
    if (answer.kind !== "domain-note") return { ok: false, reason: "not_a_domain_note" };
    const post = this.deps.posts.findPostById(answer.post_id);
    if (!post) return { ok: false, reason: "answer_not_found" };
    const actor = `${input.platform}:${input.actorId}`;
    if (answer.answered_by !== actor && this.deps.isReplyAuthorAllowed?.(input.platform, input.actorId) !== true) {
      return { ok: false, reason: "forbidden" };
    }
    const domainId = parseNoteDomainChoice(input.choice);
    if (domainId === undefined) return { ok: false, reason: "invalid_choice" };
    const outcome = await this.send(post, answer.id, {
      domainId,
      projectWide: domainId === null,
      note: answer.answer_text,
      chosenBy: actor,
    }, (current) => current?.status === "awaiting_choice");
    return { ok: true, outcome };
  }

  /**
   * 失敗・選択待ち・止まった送信の再試行 (`POST .../note-delivery/retry`)。
   * 選択済みの宛先はそのまま再送し、先頭指定や未決は照合からやり直す。
   */
  async retry(answerId: number): Promise<NoteChoiceResult> {
    const answer = this.deps.posts.findAnswerById(answerId);
    if (!answer) return { ok: false, reason: "answer_not_found" };
    if (answer.kind !== "domain-note") return { ok: false, reason: "not_a_domain_note" };
    const post = this.deps.posts.findPostById(answer.post_id);
    if (!post) return { ok: false, reason: "answer_not_found" };
    const current = this.deps.posts.findNoteDelivery(answer.id);
    if (current && (isTerminal(current) || this.isActiveSending(current))) {
      return { ok: true, outcome: toOutcome(current) };
    }
    if (current?.chosen_by && (current.domain_id !== null || current.project_wide === 1)) {
      const outcome = await this.send(post, answer.id, {
        domainId: current.project_wide === 1 ? null : current.domain_id,
        projectWide: current.project_wide === 1,
        note: answer.answer_text,
        chosenBy: current.chosen_by,
      }, (row) => this.isRetryable(row));
      return { ok: true, outcome };
    }
    return { ok: true, outcome: await this.resolveAndSend(post, answer) };
  }

  private async resolveAndSend(post: DomainReviewPostRow, answer: DomainReviewAnswerRow): Promise<NoteDeliveryOutcome> {
    const domains = await this.deps.anatomia.fetchRawDomains(post.anatomia_project_id);
    if (!domains.ok) {
      return this.fail(answer.id, post, `domains_unavailable:${domains.reason}`);
    }
    const candidates = domains.data.map((domain) => ({ id: domain.domain, name: domain.domain }));
    const resolution = resolveNoteDomain(answer.answer_text, candidates);
    if (resolution.kind === "unresolved") {
      const { choices, omitted } = buildNoteDomainChoices(candidates);
      this.deps.posts.saveNoteDelivery(answer.id, { status: "awaiting_choice", domainId: null, projectWide: false });
      this.deps.log.info(
        `domain-review: note awaiting domain choice code=${post.code} answer=${answer.id} choices=${choices.length} omitted=${omitted}`,
      );
      return { status: "awaiting_choice", answerId: answer.id, choices, omitted };
    }
    return this.send(post, answer.id, {
      domainId: resolution.domainId,
      projectWide: false,
      note: resolution.note,
      chosenBy: null,
    }, (current) => this.isRetryable(current));
  }

  private async send(
    post: DomainReviewPostRow,
    answerId: number,
    target: SendTarget,
    claimable: (current: DomainReviewNoteDeliveryRow | null) => boolean,
  ): Promise<NoteDeliveryOutcome> {
    const claimed = this.deps.posts.claimNoteDelivery(answerId, {
      domainId: target.domainId,
      projectWide: target.projectWide,
      chosenBy: target.chosenBy,
    }, claimable);
    if (!claimed) {
      // 二重クリック・同時再配送。先に占有した側の状態をそのまま返し、送らない。
      const current = this.deps.posts.findNoteDelivery(answerId);
      return current ? toOutcome(current) : { status: "failed", answerId, reason: "not_claimable" };
    }
    const result = await this.deps.anatomia.submitReviewNotes(post.anatomia_project_id, [{
      ...(target.domainId === null ? {} : { domainId: target.domainId }),
      note: target.note,
      reviewRef: noteReviewRef(answerId),
      kind: "other",
    }]);
    if (!result.ok) return this.fail(answerId, post, `anatomia_${result.reason}`);
    const proposal = result.data.proposals[0];
    if (proposal) {
      this.deps.posts.saveNoteDelivery(answerId, { status: "sent", proposalId: proposal.proposalId });
      this.deps.log.info(
        `domain-review: note sent code=${post.code} answer=${answerId} domain=${target.domainId ?? "(project)"} proposal=${proposal.proposalId}`,
      );
      return { status: "sent", answerId, domainId: target.domainId, proposalId: proposal.proposalId };
    }
    const rejected = result.data.rejected[0];
    if (rejected) {
      this.deps.posts.saveNoteDelivery(answerId, { status: "rejected", reason: rejected.reason });
      this.deps.log.warn(
        `domain-review: note rejected code=${post.code} answer=${answerId} domain=${target.domainId ?? "(project)"} reason=${rejected.reason}`,
      );
      return { status: "rejected", answerId, domainId: target.domainId, reason: rejected.reason };
    }
    return this.fail(answerId, post, "anatomia_empty_response");
  }

  private fail(answerId: number, post: DomainReviewPostRow, reason: string): NoteDeliveryOutcome {
    this.deps.posts.saveNoteDelivery(answerId, { status: "failed", reason });
    this.deps.log.warn(
      `domain-review: note not delivered code=${post.code} answer=${answerId} reason=${reason}`
      + " (回答は Cc の台帳に残っています。再試行: POST /v1/domain-review/answers/<id>/note-delivery/retry)",
    );
    return { status: "failed", answerId, reason };
  }

  private isRetryable(current: DomainReviewNoteDeliveryRow | null): boolean {
    if (!current) return true;
    if (current.status === "failed" || current.status === "awaiting_choice") return true;
    return current.status === "sending" && !this.isActiveSending(current);
  }

  private isActiveSending(row: DomainReviewNoteDeliveryRow): boolean {
    const now = this.deps.now?.() ?? Date.now();
    return row.status === "sending" && now - row.updated_at < NOTE_DELIVERY_STALE_MS;
  }
}

function isTerminal(row: DomainReviewNoteDeliveryRow): boolean {
  return row.status === "sent" || row.status === "rejected";
}

/** 台帳の行を応答へ写す。選択待ちの選択肢は台帳に持たないので空で返す。 */
function toOutcome(row: DomainReviewNoteDeliveryRow): NoteDeliveryOutcome {
  const domainId = row.project_wide === 1 ? null : row.domain_id;
  switch (row.status) {
    case "sent":
      return { status: "sent", answerId: row.answer_id, domainId, proposalId: row.proposal_id ?? "" };
    case "rejected":
      return { status: "rejected", answerId: row.answer_id, domainId, reason: row.reason ?? "unknown" };
    case "failed":
      return { status: "failed", answerId: row.answer_id, reason: row.reason ?? "unknown" };
    case "awaiting_choice":
      return { status: "awaiting_choice", answerId: row.answer_id, choices: [], omitted: 0 };
    case "sending":
      return { status: "sending", answerId: row.answer_id };
  }
}
