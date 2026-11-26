export default {
  post(result: { through: string; summary: string } | null, through: string, summary: string,
    receipt: { id: string; last: boolean } | null): boolean {
    if (receipt?.last && receipt.id) return result?.through === through && result.summary === summary;
    return result === null;
  },
};
