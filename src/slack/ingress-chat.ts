/** Build the session-bound chat payload used to mirror Slack consultation posts to Discord. */
export function buildSlackConsultationBody(
  text: string,
  userId: string,
  sessionId: string | null,
): Record<string, unknown> {
  return {
    channel: "consultation",
    session_id: sessionId,
    text: text.slice(0, 2000),
    author_label: userId,
    metadata: { source: "slack", slack_user_id: userId },
  };
}
