/** Adapter: trusted CLI hook command; request text never becomes shell syntax. */
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function inquiryReadSettings(root: string): Promise<string> {
  const hook = fileURLToPath(new URL("../../tools/federation-inquiry-read-guard.mjs", import.meta.url));
  await access(hook);
  const quote = (value: string): string => {
    if (/["%`$\r\n]/.test(value)) throw new Error("Unsafe inquiry hook installation path");
    return `"${value}"`;
  };
  const command = `${quote(process.execPath)} ${quote(hook)} ${Buffer.from(root, "utf8").toString("base64url")}`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command, timeout: 10 }] }] } });
}
