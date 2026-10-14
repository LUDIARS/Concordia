/** @implements SPEC-CONSULT-DRIVE-TRANSFER */
/**
 * C-3: the transfer is configured only when a service account key (type service_account with client_email and
 * private_key) is present; anything missing or unreadable yields null (fail closed). No parent folder is part of it.
 */
export default {
  post(result: unknown, input: unknown): boolean {
    const raw = input as { serviceAccountJson?: unknown } | null;
    let key: Record<string, unknown> | null = null;
    try {
      key = typeof raw?.serviceAccountJson === "string" ? JSON.parse(raw.serviceAccountJson) as Record<string, unknown> : null;
    } catch {
      key = null;
    }
    const keyOk = !!key && key.type === "service_account" && typeof key.client_email === "string" && typeof key.private_key === "string";
    if (!keyOk) return result === null;
    if (result === null) return true;
    const config = result as Record<string, unknown> & { serviceAccount?: { clientEmail?: unknown } };
    return !("parentFolderId" in config) && config.serviceAccount?.clientEmail === (key!.client_email as string).trim();
  },
};
