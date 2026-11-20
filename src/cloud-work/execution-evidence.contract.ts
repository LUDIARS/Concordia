export default {
  post(result: Record<string, unknown>, receipt: unknown, observation: unknown, verified: unknown, quality: unknown, release: unknown): boolean {
    return result.receipt === receipt && result.providerTerminal === observation && result.artifactVerification === verified
      && result.qualityAcceptance === quality && result.resourceRelease === release;
  },
};
