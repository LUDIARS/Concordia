import { redactSecrets } from "../shared/redact-secrets.js";
import { neutralizeMentions } from "./reminder-policy.js";

export default {
  post(result: string | null, value: unknown): boolean {
    if (typeof value !== "string" || !value.trim()) return result === null;
    const safe = neutralizeMentions(redactSecrets(value.replace(/\s+/g, " ").trim()));
    const characters = Array.from(safe);
    const expected = characters.length > 80 ? characters.slice(0, 79).join("") + "…" : safe;
    return result === expected && !/[\r\n]/.test(result);
  },
};
