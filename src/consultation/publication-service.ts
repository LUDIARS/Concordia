/**
 * 相談からの公開候補のユースケース (spec/feature/tech-consultation.md §5)。
 *
 * - 候補はセッションが書き直した要約として出す (propose)。 相談中 (open) のセッションだけが出せる。
 * - 公開・公開しないを決められるのは相談者本人だけ。 権限者は取り下げだけできる (CC-CONSULT-INV-04)。
 * - 公開は Tabula にメンバー共有ページを作ってから published にする。 投稿に失敗したら proposed のまま
 *   理由を残し、 もう一度押せば再試行できる。 Tabula が未設定なら公開できない (黙って成功にしない)。
 *
 * @implements SPEC-CONSULT-PUBLISH
 * @implements SPEC-CONSULT-TABULA
 */

import type {
  ConsultationPublicationRow,
  ConsultationPublicationsRepo,
} from "../db/consultation-publications-repo.js";
import type { PrivateConsultationRow, PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import type { TabulaConnection, TabulaImportInput, TabulaImportResult } from "./tabula-client.js";

export const MAX_PUBLICATION_TITLE_CHARS = 200;
export const MAX_PUBLICATION_SUMMARY_CHARS = 20_000;
export const CONSULTATION_TAG = "技術相談";

export type PublicationError =
  | "consultation_not_found"
  | "consultation_not_open"
  | "publication_not_found"
  | "not_proposed"
  | "not_requester"
  | "not_approver"
  | "invalid_proposal"
  | "tabula_not_configured"
  | "tabula_failed";

type Result<T> = ({ ok: true } & T) | { ok: false; error: PublicationError };

export interface PublicationPorts {
  publications: Pick<ConsultationPublicationsRepo,
    "create" | "find" | "setCardMessage" | "markPublished" | "markClosed" | "recordError">;
  consultations: Pick<PrivateConsultationsRepo, "find" | "findBySession" | "members">;
  departmentName(departmentId: string): string | null;
  tabulaConnection(): TabulaConnection | null;
  importPage(connection: TabulaConnection, input: TabulaImportInput): Promise<TabulaImportResult>;
  now?: () => number;
}

export class PublicationService {
  private readonly now: () => number;

  constructor(private readonly ports: PublicationPorts) {
    this.now = ports.now ?? Date.now;
  }

  /** セッションが出した公開候補を受け付ける。 */
  propose(input: { sessionId: string; title: unknown; summary: unknown }): Result<{
    publication: ConsultationPublicationRow;
    consultation: PrivateConsultationRow;
    tabulaReady: boolean;
  }> {
    const consultation = this.ports.consultations.findBySession(input.sessionId);
    if (!consultation) return { ok: false, error: "consultation_not_found" };
    if (consultation.status !== "open") return { ok: false, error: "consultation_not_open" };
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!title || !summary || title.length > MAX_PUBLICATION_TITLE_CHARS || summary.length > MAX_PUBLICATION_SUMMARY_CHARS) {
      return { ok: false, error: "invalid_proposal" };
    }
    const publication = this.ports.publications.create({ consultation_id: consultation.id, title, summary }, this.now());
    return { ok: true, publication, consultation, tabulaReady: this.ports.tabulaConnection() !== null };
  }

  /** 相談者本人が公開する。 editedSummary を渡せば直した文で公開する。 */
  async publish(input: { publicationId: string; actorUserId: string; editedSummary?: string }): Promise<Result<{
    publication: ConsultationPublicationRow;
  }>> {
    const target = this.target(input.publicationId);
    if (!target.ok) return target;
    if (target.consultation.requester_user_id !== input.actorUserId) return { ok: false, error: "not_requester" };
    const connection = this.ports.tabulaConnection();
    if (!connection) return { ok: false, error: "tabula_not_configured" };
    const text = input.editedSummary?.trim() || target.publication.summary;
    if (text.length > MAX_PUBLICATION_SUMMARY_CHARS) return { ok: false, error: "invalid_proposal" };
    const departmentName = this.ports.departmentName(target.consultation.department_id);
    let page: TabulaImportResult;
    try {
      page = await this.ports.importPage(connection, {
        key: `concordia-consultation:${target.publication.id}`,
        title: target.publication.title,
        text,
        tags: departmentName ? [CONSULTATION_TAG, departmentName] : [CONSULTATION_TAG],
      });
    } catch (error) {
      this.ports.publications.recordError(target.publication.id, (error as Error).message.slice(0, 200), this.now());
      return { ok: false, error: "tabula_failed" };
    }
    if (!this.ports.publications.markPublished(target.publication.id, {
      decided_by: input.actorUserId,
      published_text: text,
      tabula_page_id: page.pageId,
      tabula_url: page.url,
    }, this.now())) {
      return { ok: false, error: "not_proposed" };
    }
    return { ok: true, publication: this.ports.publications.find(target.publication.id)! };
  }

  /** 本人が「公開しない」を選ぶ。 */
  decline(publicationId: string, actorUserId: string): Result<{ publication: ConsultationPublicationRow }> {
    const target = this.target(publicationId);
    if (!target.ok) return target;
    if (target.consultation.requester_user_id !== actorUserId) return { ok: false, error: "not_requester" };
    return this.close(publicationId, "declined", actorUserId);
  }

  /** 権限者が候補を取り下げる (公開はできない)。 */
  withdraw(publicationId: string, actorUserId: string): Result<{ publication: ConsultationPublicationRow }> {
    const target = this.target(publicationId);
    if (!target.ok) return target;
    const isApprover = this.ports.consultations.members(target.consultation.id)
      .some((member) => member.platform_user_id === actorUserId && member.reason === "approver");
    if (!isApprover) return { ok: false, error: "not_approver" };
    return this.close(publicationId, "withdrawn", actorUserId);
  }

  setCardMessage(publicationId: string, messageId: string): void {
    this.ports.publications.setCardMessage(publicationId, messageId, this.now());
  }

  private close(publicationId: string, status: "declined" | "withdrawn", actorUserId: string):
    Result<{ publication: ConsultationPublicationRow }> {
    if (!this.ports.publications.markClosed(publicationId, status, actorUserId, this.now())) {
      return { ok: false, error: "not_proposed" };
    }
    return { ok: true, publication: this.ports.publications.find(publicationId)! };
  }

  private target(publicationId: string):
    | { ok: true; publication: ConsultationPublicationRow; consultation: PrivateConsultationRow }
    | { ok: false; error: PublicationError } {
    const publication = this.ports.publications.find(publicationId);
    if (!publication) return { ok: false, error: "publication_not_found" };
    if (publication.status !== "proposed") return { ok: false, error: "not_proposed" };
    const consultation = this.ports.consultations.find(publication.consultation_id);
    if (!consultation) return { ok: false, error: "consultation_not_found" };
    return { ok: true, publication, consultation };
  }
}
