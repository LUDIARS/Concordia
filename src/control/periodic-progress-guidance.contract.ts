export default {
  post(result: unknown): boolean {
    return typeof result === "string" && ["概算%", "根拠", "未確認", "100%", "完了条件", "通知", "終端status", "依頼者", "人間", "予算"].every((word) => result.includes(word));
  },
};
