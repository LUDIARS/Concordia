/** @implements spec/feature/personal-ai-budget.md §4 — 相談の公開の報奨は公開済みの候補だけ、根拠は候補の id、受取人は相談者 */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const publication = args[0] as { id?: unknown; status?: unknown; consultation_id?: unknown } | undefined;
    const consultation = args[1] as { id?: unknown; subsidiary_id?: unknown; requester_user_id?: unknown } | undefined;
    if (!publication || !consultation) return false;
    const eligible = publication.status === "published" && publication.consultation_id === consultation.id;
    if (!eligible) return result === null;
    const request = result as {
      kind?: unknown;
      sourceRef?: unknown;
      recipient?: { subsidiaryId?: unknown; platform?: unknown; platformUserId?: unknown };
    } | null;
    return request !== null
      && request.kind === "tabula"
      && request.sourceRef === publication.id
      && request.recipient?.platform === "discord"
      && request.recipient.platformUserId === consultation.requester_user_id
      && request.recipient.subsidiaryId === consultation.subsidiary_id;
  },
};
