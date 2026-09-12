/** @implements spec/feature/danger-command-approval.md — transport-neutral contract */
export interface PushWarning {
  remoteName: "origin";
  remoteUrl: string;
  updates: Array<{ localRef: string; localSha: string; remoteRef: string; remoteSha: string }>;
}
export interface PushWarningPrompt {
  sessionId: string;
  repoPath: string;
  branch: string;
  push: PushWarning;
}
export type PushWarningDecision = "approved" | "denied" | "unavailable" | "busy";
export interface PushWarningChannel {
  owns(sessionId: string): boolean;
  request(prompt: PushWarningPrompt): Promise<PushWarningDecision>;
}
export interface PushWarningBridge {
  register(channel: PushWarningChannel): () => void;
  format(prompt: PushWarningPrompt): string;
  requester(sessionId: string): { platform: "discord" | "slack"; userId: string } | null;
}
