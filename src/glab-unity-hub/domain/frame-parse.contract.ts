/** @implements spec/feature/glab-unity-hub.md — C-4 parseFrame (guh-C-4) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [text] = args as [string];
    const parsed = result as { kind: string };
    let value: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(text) as unknown;
      value = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    } catch { value = null; }
    if (Buffer.byteLength(text, "utf8") > 64 * 1024 || !value || value.v !== 1) return parsed.kind === "invalid";
    const payload = (value.payload ?? {}) as Record<string, unknown>;
    if (value.type === "auth") return parsed.kind === (typeof payload.token === "string" && payload.token !== "" ? "auth" : "invalid");
    if (parsed.kind === "request") return typeof value.id === "string" && typeof value.type === "string";
    return parsed.kind === "invalid";
  },
};
