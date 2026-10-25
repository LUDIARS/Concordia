export default {
  post(result: unknown, session: unknown, operation: unknown): boolean {
    const live = !!session && ["active", "blocked"].includes((session as { status: string }).status);
    return result === (!live ? "orbis_unauthorized" : operation === "reveal" ? "orbis_reveal_requires_user_utterance" : null);
  },
};
