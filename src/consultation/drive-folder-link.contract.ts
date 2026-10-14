/** @implements SPEC-CONSULT-DRIVE-TRANSFER */
/**
 * C-4: a shared folder is linked to a consultation only when it is a folder outside the trash that the service account
 * can add to (writer or above), and it is not linked to a consultation of a different requester.
 */
type Folder = { mimeType?: unknown; trashed?: unknown; canAddChildren?: unknown; linkedConsultationId?: unknown };
type Target = { consultationId?: unknown; requesterUserId?: unknown };

export default {
  post(result: unknown, folder?: unknown, target?: unknown, requesterOf?: unknown): boolean {
    if (!result || typeof result !== "object" || !folder || typeof folder !== "object") return false;
    const f = folder as Folder;
    const t = (target ?? {}) as Target;
    const decision = result as { ok?: unknown; reason?: unknown };
    const linked = typeof f.linkedConsultationId === "string" ? f.linkedConsultationId : null;
    const otherRequester = linked !== null && linked !== t.consultationId && typeof requesterOf === "function"
      && (requesterOf as (id: string) => unknown)(linked) !== t.requesterUserId;
    const allowed = f.mimeType === "application/vnd.google-apps.folder" && f.trashed !== true
      && f.canAddChildren === true && !otherRequester;
    return decision.ok === allowed;
  },
};
