/** C-14: a mixed instruction list excludes bug-report/fix items individually. */
export default {
  post(result: unknown): boolean {
    return Array.isArray(result) && result.every(fragment =>
      typeof fragment.content === "string"
      && !/(?:バグ|不具合|障害)(?:報告|修正)|\b(?:bugfix|fix\s*:)/i.test(fragment.content));
  },
};
