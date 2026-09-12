/** @implements spec/feature/danger-command-approval.md CC-PW-02/03/04 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pushWarningText, type PushWarningDecision, type PushWarningPrompt } from "./push-warning.js";

let showing = false;

/** Server-owned UI: no HTTP body or reusable token can provide the decision. */
export async function requestPushWarning(prompt: PushWarningPrompt): Promise<PushWarningDecision> {
  if (process.platform !== "win32") return "unavailable";
  if (showing) return "busy";
  showing = true;
  try {
    return await new Promise<PushWarningDecision>((resolve) => {
      const child = execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File",
        fileURLToPath(new URL("../../tools/push-warning.ps1", import.meta.url))], {
        windowsHide: true, encoding: "utf8", timeout: 95_000, maxBuffer: 4096,
      }, (error, stdout) => resolve(error ? "unavailable" : stdout.trim() === "approved" ? "approved" : "denied"));
      // Script is fixed; the complete prompt crosses stdin strictly as UTF-8 JSON data.
      child.stdin?.on("error", () => { /* Child failure is resolved by execFile's completion callback. */ });
      child.stdin?.end(JSON.stringify({ text: pushWarningText(prompt) }), "utf8");
    });
  } finally {
    showing = false;
  }
}
