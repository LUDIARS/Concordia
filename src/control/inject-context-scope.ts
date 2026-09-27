import type { ContextLinks } from "./inject-context-links.js";

export interface ContextScope { ddd: boolean; praeforma: string; anatomia: string }

/** The three additions are independent; no proof means no addition. */
export function selectContextScope(present: boolean, dddEnabled: boolean | null, links: ContextLinks): ContextScope {
  if (!present) return { ddd: false, praeforma: "", anatomia: "" };
  return { ddd: dddEnabled === true, praeforma: links.praeforma, anatomia: links.anatomia };
}
