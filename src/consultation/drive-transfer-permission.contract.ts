/** @implements SPEC-CONSULT-DRIVE-TRANSFER */
/**
 * C-2: the consultation folder is shared only as a writer to a single user address; it never produces a link
 * (anyone) or domain permission, and an unreadable address yields no permission.
 */
export default {
  post(result: unknown, email: unknown): boolean {
    if (result === null) return true;
    if (!result || typeof result !== "object") return false;
    const permission = result as { type?: unknown; role?: unknown; emailAddress?: unknown };
    return permission.type === "user"
      && permission.role === "writer"
      && typeof email === "string"
      && permission.emailAddress === email.trim()
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(permission.emailAddress as string)
      && Object.keys(permission).length === 3;
  },
};
