/** Predicate for Augur registry records produced from declared domains. */
export default {
  post(result) {
    return result !== undefined
      && Array.isArray(result.domains?.business)
      && result.domains.business.length > 0
      && Array.isArray(result.domains?.program)
      && result.domains.program.every((domain) => result.domains.business.includes(domain))
      && Array.isArray(result.anchors);
  },
};
