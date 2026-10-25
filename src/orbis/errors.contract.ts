export default {
  post(result: unknown): boolean {
    return ["orbis_token_missing", "orbis_unavailable", "orbis_unauthorized", "orbis_operation_failed",
      "orbis_invalid_request", "orbis_reveal_requires_user_utterance"].includes(String(result));
  },
};
