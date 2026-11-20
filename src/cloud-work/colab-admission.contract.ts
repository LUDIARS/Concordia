export default {
  post(result: unknown, input: { ownerApproved: boolean; evidence: { code: string; data: string; destination: string }; ownerDestination: string }): boolean {
    return result === (input.ownerApproved && input.evidence.code === "public"
      && input.evidence.data === "non_confidential" && input.evidence.destination === input.ownerDestination);
  },
};
