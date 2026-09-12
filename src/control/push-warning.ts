/** @implements spec/feature/danger-command-approval.md CC-PW-01/02 */
import { z } from "zod";
import type { PushWarningPrompt } from "../platform/push-warning.js";
export type { PushWarning, PushWarningPrompt, PushWarningDecision } from "../platform/push-warning.js";

const printable = z.string().min(1).max(2048).regex(/^[\x20-\x7e]+$/);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const ref = printable.refine((value) => /^refs\/(heads|tags)\//.test(value)
  && !/[ ~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{"));
export const PushWarningSchema = z.object({
  remoteName: z.literal("origin"),
  remoteUrl: printable,
  updates: z.array(z.object({
    localRef: printable,
    localSha: sha,
    remoteRef: ref,
    remoteSha: sha,
  }).strict()).min(1).max(32),
}).strict().refine((value) => new Set(value.updates.map((update) => update.remoteRef)).size === value.updates.length,
  "Duplicate destination refs are not allowed");


/** Credentials and alternate transports must never be copied into a warning/audit. */
export function isWarningRemoteAllowed(remoteUrl: string, repoOrigin: string | null): boolean {
  if (remoteUrl !== repoOrigin) return false;
  return /^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/[a-zA-Z0-9_./-]+$/.test(remoteUrl)
    || /^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(remoteUrl);
}

export function pushWarningText(prompt: PushWarningPrompt): string {
  const updates = prompt.push.updates.map((update) =>
    `${update.remoteRef}\r\n  old: ${update.remoteSha}\r\n  new: ${update.localSha}\r\n  source: ${update.localRef}`).join("\r\n\r\n");
  return ["WARNING: Git push exception / 危険操作の特例", "",
    "公開履歴やタグが置換・削除される可能性があります。他の利用者にも影響します。",
    "この承認は表示されたpush一回のCc制限だけを解除します。他のGitフックは引き続き適用されます。",
    "AIは自己承認しないでください。Discord承認カードは10分で失効します。", "",
    `Session: ${prompt.sessionId}`, `Repository: ${prompt.repoPath}`, `Branch: ${prompt.branch}`,
    `Remote: ${prompt.push.remoteName} ${prompt.push.remoteUrl}`, "", updates].join("\r\n");
}
