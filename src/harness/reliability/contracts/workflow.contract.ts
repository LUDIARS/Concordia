// @spec ハーネス信頼性の実装境界
export default {
  post(result: unknown, prompt: string) {
    if (!Array.isArray(result)) return false;
    if (/^\[(?:自動確認|Cc Session policy)\]/.test(prompt.trim())) return result.length === 0;
    return result.every(item => item.source === "deterministic" && typeof item.skill === "string");
  },
};
