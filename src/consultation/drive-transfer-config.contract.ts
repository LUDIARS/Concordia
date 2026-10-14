/** @implements SPEC-CONSULT-DRIVE-TRANSFER */
/**
 * C-3: the transfer is configured only when both a service account key (type service_account with client_email
 * and private_key) and a parent folder id are present; anything missing or unreadable yields null (fail closed).
 */
export default {
  post(result: unknown, input: unknown): boolean {
    const raw = input as { serviceAccountJson?: unknown; parentFolderId?: unknown } | null;
    const parent = typeof raw?.parentFolderId === "string" ? raw.parentFolderId.trim() : "";
    let key: Record<string, unknown> | null = null;
    try {
      key = typeof raw?.serviceAccountJson === "string" ? JSON.parse(raw.serviceAccountJson) as Record<string, unknown> : null;
    } catch {
      key = null;
    }
    const keyOk = !!key && key.type === "service_account" && typeof key.client_email === "string" && typeof key.private_key === "string";
    if (!parent || !keyOk) return result === null;
    if (result === null) return true;
    const config = result as { parentFolderId?: unknown; serviceAccount?: { clientEmail?: unknown } };
    return config.parentFolderId === parent && config.serviceAccount?.clientEmail === (key!.client_email as string).trim();
  },
};
