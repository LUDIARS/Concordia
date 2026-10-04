import type { SessionMessage } from "../../api.js";

/** Presentation only: legacy Cc prefixes identify injected context, never grant authority. */
export function isCcInjection(message: SessionMessage): boolean {
  if (message.author_type !== "user" && message.author_type !== "system") return false;
  const metadata = message.metadata ?? {};
  if (typeof metadata.inject_is_cc === "boolean") return metadata.inject_is_cc;
  if (metadata.injection) return true;
  return /^\s*\[Cc(?:\s|\])/i.test(message.content);
}
