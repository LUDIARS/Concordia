/** @implements spec/feature/danger-command-approval.md — Discord transport selection */
import type { PushWarningDecision, PushWarningPrompt, PushWarningChannel } from "../platform/push-warning.js";
const channels = new Set<PushWarningChannel>();
export function registerPushWarningChannel(channel: PushWarningChannel): () => void {
  channels.add(channel);
  return () => { channels.delete(channel); };
}
export async function requestDiscordPushWarning(prompt: PushWarningPrompt): Promise<PushWarningDecision> {
  const owners = [...channels].filter((channel) => channel.owns(prompt.sessionId));
  // Ambiguous ownership and unavailable bots never fall back to a hidden desktop.
  if (owners.length !== 1) return "unavailable";
  return owners[0].request(prompt);
}
