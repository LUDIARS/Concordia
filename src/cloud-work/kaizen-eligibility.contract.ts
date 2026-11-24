export default {
  post(result: { eligible: boolean }, evidence: {
    repositoryBytes: number | null; environmentPreparable: boolean | null;
    requiresLargeProjectClone: boolean | null; computeIntensiveArtifactGeneration: boolean | null;
    requiresLlmGuidance: boolean | null;
  }, origin?: string): boolean {
    const size = evidence.repositoryBytes;
    return result.eligible === (typeof size === "number" && Number.isSafeInteger(size) && size >= 0 && size <= 50_000_000
      && evidence.environmentPreparable === true && evidence.requiresLargeProjectClone === false
      && evidence.requiresLlmGuidance === true
      && (origin === "kaizen-daily" || evidence.computeIntensiveArtifactGeneration === true));
  },
};
